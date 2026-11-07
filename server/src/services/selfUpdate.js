import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { run } from './exec.js';

/**
 * The panel deploying itself.
 *
 * Every other project here is updated by `git fetch` + `git reset --hard` +
 * build + pm2 restart. The panel is the one project that cannot do that from
 * the inside: the restart kills the process holding the job. So the work
 * happens in a detached helper (server/scripts/self-update.js) that outlives
 * the restart and reports through two files in server/data; this module
 * starts it, reads those files back, and answers "is there anything new?".
 */

const SCRIPT = path.join(config.rootDir, 'server', 'scripts', 'self-update.js');
const LOG = path.join(config.dataDir, 'self-update.log');
const STATE = path.join(config.dataDir, 'self-update.json');

const git = async (...args) => (await run('git', args, { cwd: config.rootDir })).stdout.trim();

/**
 * Which pm2 process is this panel. pm2 injects `name` and `pm_id` into every
 * app it starts, so under pm2 we know it for certain; PANEL_PM2_NAME is the
 * escape hatch for an unusual setup, and the default covers a dev run.
 */
export function pm2Name() {
  if (process.env.PANEL_PM2_NAME) return process.env.PANEL_PM2_NAME;
  if (process.env.pm_id !== undefined && process.env.name) return process.env.name;
  return 'server-manager';
}

/** owner/repo from an https or ssh remote URL, or '' when it is neither. */
export function repoFullName(url = '') {
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

let ownRepo = null; // cached: the remote cannot change without a restart
export async function ownRepoFullName() {
  if (ownRepo === null) ownRepo = repoFullName(await git('config', '--get', 'remote.origin.url'));
  return ownRepo;
}

/** True when a webhook payload is about the panel's own repository. */
export async function isOwnRepo(fullName) {
  const own = await ownRepoFullName();
  return Boolean(own && fullName && own.toLowerCase() === String(fullName).toLowerCase());
}

export const currentBranch = () => git('rev-parse', '--abbrev-ref', 'HEAD');

function panelVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.rootDir, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

/** What is installed right now. No network, safe to call on every poll. */
export async function repoState() {
  const remote = await git('config', '--get', 'remote.origin.url');
  const sha = await git('rev-parse', 'HEAD');
  const dirty = (await git('status', '--porcelain')).split('\n').filter(Boolean);
  return {
    root: config.rootDir,
    branch: await currentBranch(),
    remote,
    repoFullName: repoFullName(remote),
    pm2Name: pm2Name(),
    version: panelVersion(),
    commit: {
      sha,
      short: sha.slice(0, 7),
      subject: await git('log', '-1', '--pretty=%s'),
      at: await git('log', '-1', '--pretty=%cI'),
      author: await git('log', '-1', '--pretty=%an'),
    },
    // An update is a hard reset, so these edits would be thrown away. The UI
    // shows them BEFORE the button is pressed rather than after.
    localChanges: {
      tracked: dirty.filter((l) => !l.startsWith('??')).map((l) => l.slice(3)),
      untracked: dirty.filter((l) => l.startsWith('??')).map((l) => l.slice(3)),
    },
  };
}

/** Ask GitHub what is on the branch. Hits the network — called on demand. */
export async function checkRemote() {
  const branch = await currentBranch();
  const fetched = await run('git', ['fetch', 'origin', branch], { cwd: config.rootDir, timeout: 60_000 });
  if (fetched.code !== 0) {
    throw new Error(fetched.stderr.trim() || `git fetch origin ${branch} failed`);
  }
  const behind = Number(await git('rev-list', '--count', `HEAD..origin/${branch}`)) || 0;
  const ahead = Number(await git('rev-list', '--count', `origin/${branch}..HEAD`)) || 0;
  const raw = behind
    ? await git('log', '--pretty=%h\u001f%s\u001f%cI\u001f%an', `HEAD..origin/${branch}`)
    : '';
  return {
    branch,
    behind,
    ahead,
    checkedAt: new Date().toISOString(),
    commits: raw
      ? raw.split('\n').map((line) => {
          const [short, subject, at, author] = line.split('\u001f');
          return { short, subject, at, author };
        })
      : [],
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The last (or running) update: its state file plus the tail of its log. */
export function status({ logLines = 200 } = {}) {
  let job = null;
  try {
    job = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    /* never updated from here yet */
  }
  // The helper is a separate process: if it died without writing an ending —
  // OOM, a kill, a crash before its own error handler — say so instead of
  // showing a spinner that never stops.
  if (job?.status === 'running' && job.pid && !alive(job.pid)) {
    job = { ...job, status: 'failed', error: job.error || 'the updater stopped unexpectedly', orphaned: true };
  }
  let log = '';
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n');
    log = lines.slice(Math.max(0, lines.length - logLines)).join('\n');
  } catch {
    /* no log yet */
  }
  return { job, log };
}

export const isRunning = () => status({ logLines: 0 }).job?.status === 'running';

/**
 * Start an update. Returns as soon as the helper is spawned — the caller must
 * answer the HTTP request before the restart lands, so progress is reported
 * by polling status() afterwards.
 */
export function start({ trigger = 'manual', force = false } = {}) {
  if (isRunning()) return { ok: false, error: 'An update is already running' };
  if (!fs.existsSync(SCRIPT)) return { ok: false, error: `Updater missing at ${SCRIPT}` };

  fs.mkdirSync(config.dataDir, { recursive: true });
  // The helper writes the log itself; this fd only catches a crash before it
  // gets that far. Both are O_APPEND, so neither can overwrite the other.
  const out = fs.openSync(LOG, 'a');
  let child;
  try {
    child = spawn(process.execPath, [SCRIPT], {
      cwd: config.rootDir,
      detached: true, // new session: pm2 killing this panel must not kill it
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        SU_TRIGGER: trigger,
        SU_FORCE: force ? '1' : '0',
        SU_PM2_NAME: pm2Name(),
      },
    });
  } finally {
    fs.closeSync(out);
  }
  child.unref();

  // Seed the state file so a poll between now and the helper's first write
  // already sees a running job.
  const seed = {
    status: 'running',
    step: 'start',
    trigger,
    force,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  try {
    fs.writeFileSync(STATE, JSON.stringify(seed, null, 2));
  } catch {
    /* the helper writes its own state a moment later */
  }
  return { ok: true, pid: child.pid, trigger, force };
}
