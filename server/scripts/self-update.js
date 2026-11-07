#!/usr/bin/env node
/**
 * Update the panel to the latest commit of its own repo, then restart it.
 *
 * This runs DETACHED from the panel, because the last step kills the very
 * process that asked for the update — nothing running inside the panel could
 * own this job or report how it ended. State therefore goes to two files
 * that outlive the restart, and the panel reads them back when it returns:
 *
 *   server/data/self-update.json   the state machine (status, step, shas)
 *   server/data/self-update.log    every command's output
 *
 * Safety: if install or build fails, the repo is reset back to the commit
 * that is running and the panel is never restarted — a broken update leaves
 * the working version up. If the new version starts but fails its health
 * check, the same rollback runs and the old version is restarted, because
 * otherwise a bad commit would take the panel down with the UI that fixes
 * it. Inputs come from the environment: SU_TRIGGER, SU_FORCE, SU_PM2_NAME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { run, runStream } from '../src/services/exec.js';

const ROOT = config.rootDir;
const LOG = path.join(config.dataDir, 'self-update.log');
const STATE = path.join(config.dataDir, 'self-update.json');

/**
 * Step zero: get out from under the panel.
 *
 * pm2 kills an app's whole process TREE, and it finds that tree by walking
 * parent pids — so starting in a new session is not enough. While this
 * script is still a child of the panel, `pm2 restart` takes it down together
 * with its parent and the job ends with nothing written. So the first
 * instance re-spawns itself and exits immediately: the second instance is
 * re-parented to init, is nobody's child, and survives the restart.
 */
if (process.env.SU_DETACHED !== '1') {
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, SU_DETACHED: '1' },
  });
  fs.closeSync(fd);
  child.unref();
  process.exit(0);
}

const trigger = process.env.SU_TRIGGER || 'manual';
const force = process.env.SU_FORCE === '1';
const pm2Name = process.env.SU_PM2_NAME || 'server-manager';

const HEALTH_URL = `http://127.0.0.1:${config.port}/api/health`;
const HEALTH_TIMEOUT_MS = 90_000;

let state = {
  status: 'running',
  step: 'start',
  trigger,
  force,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  branch: null,
  from: null,
  to: null,
  upToDate: false,
  restarted: false,
  rolledBack: false,
  error: null,
};

function save(patch = {}) {
  state = { ...state, ...patch };
  try {
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  } catch {
    /* if even this fails there is nothing left to report with */
  }
}

const ANSI = /\u001b\[[0-9;]*m/g;

function log(line, stream = 'out') {
  const at = new Date().toISOString().slice(11, 19);
  try {
    // Strip colour codes: this log is read in a browser, not a terminal.
    fs.appendFileSync(LOG, `${at} ${stream === 'err' ? '! ' : ''}${String(line).replace(ANSI, '')}\n`);
  } catch {
    /* the log is a convenience; the state file is the contract */
  }
}

const onLine = ({ stream, line }) => log(line, stream === 'stderr' ? 'err' : 'out');

/** pm2 reprints its whole process table after a restart — drop that part. */
const pm2Line = ({ stream, line }) => {
  const clean = line.replace(ANSI, '').trim();
  if (/^[┌├└┐┘│]/.test(clean) || clean.includes('host metrics')) return;
  log(line, stream === 'stderr' ? 'err' : 'out');
};

/** Read-only git, for values we want rather than output to stream. */
const git = async (...args) => (await run('git', args, { cwd: ROOT })).stdout.trim();

/** A streamed command that fails the whole run when it exits non-zero. */
async function step(name, label, command, args, opts = {}) {
  save({ step: name });
  log(`==> ${label}`);
  const code = await runStream(command, args, { cwd: ROOT, ...opts }, onLine);
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

/** Wait until the panel answers its own health endpoint. */
async function waitForHealth(ms) {
  const deadline = Date.now() + ms;
  let lastError = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
  }
  log(`Health check never passed: ${lastError}`, 'err');
  return false;
}

/**
 * Put the code back the way it was. `restart` is true only when the panel has
 * already been restarted onto the broken version — then it must be restarted
 * again to pick the old one back up.
 */
async function rollback(sha, reason, { restart = false } = {}) {
  log(`Update failed: ${reason}`, 'err');
  save({ step: 'rollback', error: reason });
  log(`==> Rolling back to ${sha.slice(0, 7)}`);

  let ok = true;
  for (const [cmd, args] of [
    ['git', ['reset', '--hard', sha]],
    ['npm', ['install', '--no-audit', '--no-fund']],
    ['npm', ['run', 'build']],
  ]) {
    if ((await runStream(cmd, args, { cwd: ROOT }, onLine)) !== 0) ok = false;
  }

  if (restart) {
    log(`==> pm2 restart ${pm2Name} (back on the working version)`);
    if ((await runStream('pm2', ['restart', pm2Name], { cwd: ROOT }, pm2Line)) !== 0) ok = false;
  }

  if (ok) log('╰─ Rolled back. The panel is running the version it was before.');
  else log('╰─ ROLLBACK DID NOT FULLY SUCCEED — fix this over SSH.', 'err');

  save({
    status: 'failed',
    step: 'done',
    rolledBack: true,
    rollbackClean: ok,
    finishedAt: new Date().toISOString(),
  });
}

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(LOG, ''); // one run, one log
  save({});

  log(`╭─ Panel update (${trigger}${force ? ', forced rebuild' : ''})`);

  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')) || 'main';
  const from = await git('rev-parse', 'HEAD');
  if (!from) throw new Error(`${ROOT} is not a git repository`);
  save({ branch, from });
  log(`${ROOT} on ${branch}, at ${from.slice(0, 7)}`);

  await step('fetch', `Fetching origin/${branch}`, 'git', ['fetch', 'origin', branch]);
  const to = await git('rev-parse', `origin/${branch}`);
  if (!to) throw new Error(`origin/${branch} not found`);
  save({ to });

  if (to === from && !force) {
    log('Already at the latest commit — nothing to do.');
    return save({ status: 'success', step: 'done', upToDate: true, finishedAt: new Date().toISOString() });
  }

  if (to !== from) {
    const subjects = await git('log', '--pretty=  %h %s', `${from}..${to}`);
    if (subjects) {
      log('New commits:');
      for (const line of subjects.split('\n')) log(line);
    }
  }

  // A hard reset is how this panel deploys every other project, so it is how
  // it deploys itself — but say out loud what that throws away first.
  // Untrimmed: a worktree-only change starts with a space (" M path").
  const dirty = (await run('git', ['status', '--porcelain'], { cwd: ROOT })).stdout
    .split('\n')
    .filter((l) => l.length);
  const tracked = dirty.filter((l) => !l.startsWith('??'));
  if (tracked.length) {
    log('Local edits that this update discards (tracked files):', 'err');
    for (const line of tracked) log(`  ${line}`, 'err');
  }
  if (dirty.length > tracked.length) log('Untracked files are left alone.');

  await step('update', `Checking out ${to.slice(0, 7)}`, 'git', ['reset', '--hard', to]);

  try {
    await step('install', 'npm install', 'npm', ['install', '--no-audit', '--no-fund']);
    await step('build', 'npm run build', 'npm', ['run', 'build']);
  } catch (err) {
    // Nothing has been restarted yet: the panel is still serving the old
    // code from memory, so putting the files back is a complete recovery.
    return rollback(from, err.message);
  }

  save({ step: 'restart' });
  log(`==> pm2 restart ${pm2Name}`);
  // No --update-env: pm2 would then adopt THIS script's environment (SU_*
  // vars included), which every service deployed afterwards would inherit.
  const code = await runStream('pm2', ['restart', pm2Name], { cwd: ROOT }, pm2Line);
  // The panel process that asked for this update died on the line above.
  if (code !== 0) return rollback(from, `pm2 restart failed (exit ${code})`, { restart: true });
  save({ restarted: true, step: 'verify' });

  log('==> Waiting for the new version to answer /api/health');
  if (!(await waitForHealth(HEALTH_TIMEOUT_MS))) {
    return rollback(from, 'the new version did not come up', { restart: true });
  }

  const rebuilt = to === from; // forced run with nothing new to pull
  log(
    rebuilt
      ? `╰─ Rebuilt ${to.slice(0, 7)} and restarted.`
      : `╰─ Updated ${from.slice(0, 7)} → ${to.slice(0, 7)} and restarted.`
  );
  save({ status: 'success', step: 'done', rebuilt, finishedAt: new Date().toISOString() });
}

main().catch((err) => {
  log(err?.stack || String(err), 'err');
  save({ status: 'failed', step: 'done', error: err?.message || String(err), finishedAt: new Date().toISOString() });
});
