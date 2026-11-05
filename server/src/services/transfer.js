import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as store from '../store.js';
import { Remote } from './remote.js';
import * as bundle from './bundle.js';
import * as apply from './apply.js';

/**
 * Moving a project between two servers, orchestrated from whichever panel
 * the operator is looking at.
 *
 * Both machines run this same code, so a transfer is written once against
 * two interchangeable "sides": the local side calls functions directly, the
 * remote side calls the same things over HTTPS with that server's password.
 * Pushing is (local source → remote destination), importing is the mirror —
 * nothing else about the sequence changes.
 *
 *   connect → plan → check the destination → hold the source still →
 *   bundle → apply on the destination → release the source
 *
 * The live job (log, steps, byte progress) lives in memory; snapshots land
 * in db.json so the history survives a panel restart.
 */

const JOBS = new Map();
const MAX_LOGS = 1200;
const nowIso = () => new Date().toISOString();
const TERMINAL = ['success', 'warning', 'failed'];

const transfersDir = () => path.join(config.dataDir, 'transfers');

/**
 * A transfer cannot survive the panel process: its bundle lives in a temp
 * directory and its progress in memory. So at boot we clear the temp
 * directories and close any transfer still marked as running — with a line
 * saying what to check, because the project may have been left paused at
 * the source.
 */
(function recoverFromRestart() {
  try {
    const root = transfersDir();
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      }
    }
  } catch {
    /* never block boot on housekeeping */
  }
  try {
    for (const row of store.listTransfers()) {
      if (row.status !== 'running') continue;
      const line =
        'The panel restarted while this transfer was running, so it was abandoned. ' +
        'Nothing was deleted at the source; if its services are still paused, press Start on the project page.';
      store.saveTransfer({
        ...row,
        status: 'failed',
        phase: 'Interrupted by a panel restart',
        error: line,
        finishedAt: new Date().toISOString(),
        steps: (row.steps || []).map((s) => (s.status === 'running' ? { ...s, status: 'fail', detail: 'interrupted' } : s)),
        logs: [...(row.logs || []), { seq: (row.logs?.at(-1)?.seq || 0) + 1, ts: new Date().toISOString(), line, level: 'err' }],
      });
      console.log(`[server-manager] transfer "${row.projectName || row.id}" was interrupted by a restart`);
    }
  } catch {
    /* history is not worth a failed boot */
  }
})();

/* -------------------------------------------------------------------- job */

function createJob(fields) {
  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    phase: 'Starting…',
    steps: [],
    logs: [],
    logSeq: 0,
    progress: null,
    warnings: [],
    notes: [],
    result: null,
    pendingRelease: false,
    startedAt: nowIso(),
    finishedAt: null,
    ...fields,
  };

  // collect=false for lines mirrored from the other panel: its warnings and
  // notes reach us in the result, so counting the mirrored text as well
  // would show every one of them twice.
  job.log = (line, level = 'info', collect = true) => {
    job.logSeq += 1;
    job.logs.push({ seq: job.logSeq, ts: nowIso(), line: String(line), level });
    if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
    if (!collect) return;
    const text = String(line).replace(/^!\s*/, '');
    if (level === 'warn' && !job.warnings.includes(text)) job.warnings.push(text);
    if (level === 'note' && !job.notes.includes(text)) job.notes.push(text);
  };

  job.step = (key, label) => {
    const existing = job.steps.find((s) => s.key === key);
    const entry = existing || { key, label, status: 'running', detail: '', startedAt: nowIso() };
    if (!existing) job.steps.push(entry);
    entry.status = 'running';
    entry.label = label;
    job.phase = label;
    job.progress = null;
    persist(job);
    return (status, detail = '') => {
      entry.status = status;
      entry.detail = String(detail || '');
      entry.finishedAt = nowIso();
      job.log(`${status === 'ok' ? '✓' : status === 'skipped' ? '·' : status === 'warn' ? '!' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`, status === 'fail' ? 'err' : status === 'warn' ? 'warn' : 'step');
      persist(job);
    };
  };

  job.setProgress = (label, done, total) => {
    job.progress = { label, done, total };
  };

  JOBS.set(job.id, job);
  persist(job);
  return job;
}

/** What the API hands out — no functions, no secrets. */
export function publicJob(job, since = 0) {
  if (!job) return null;
  const { log, step, setProgress, logs, ...rest } = job;
  return {
    ...rest,
    logs: (logs || []).filter((l) => l.seq > since),
    logCount: job.logSeq,
  };
}

function persist(job) {
  const snap = publicJob(job);
  // History only needs the tail of the log.
  store.saveTransfer({ ...snap, logs: (job.logs || []).slice(-200) });
}

export function getJob(id) {
  return JOBS.get(id) || store.getTransfer(id);
}

/** One job as the API returns it, live or from history. */
export function jobView(id, since = 0) {
  const live = JOBS.get(id);
  if (live) return publicJob(live, since);
  const past = store.getTransfer(id);
  if (!past) return null;
  return { ...past, logs: (past.logs || []).filter((l) => l.seq > since) };
}

export function listJobs() {
  const live = [...JOBS.values()].map((j) => publicJob(j));
  const liveIds = new Set(live.map((j) => j.id));
  const past = store.listTransfers().filter((t) => !liveIds.has(t.id));
  return [...live, ...past]
    .map(({ logs, ...rest }) => rest)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// A finished job stays in memory for a while so the dialog that started it
// keeps showing the full log; after that the persisted snapshot (its tail,
// steps, warnings and notes) is what the history shows.
const KEEP_FINISHED_MS = 15 * 60_000;

function finish(job, status) {
  job.status = status;
  job.finishedAt = nowIso();
  job.progress = null;
  job.phase =
    status === 'success' ? 'Done' : status === 'warning' ? 'Done, with things to check' : 'Stopped';
  persist(job);
  const evict = setTimeout(() => JOBS.delete(job.id), KEEP_FINISHED_MS);
  evict.unref?.();
}

/** Drop a transfer from the history — live entry included. */
export function forgetJob(jobId) {
  const live = JOBS.get(jobId);
  if (live && live.status === 'running') return false;
  JOBS.delete(jobId);
  store.deleteTransfer(jobId);
  return true;
}

/* ------------------------------------------------------------------ sides */

function localSide(job) {
  return {
    kind: 'local',
    name: 'this server',
    info: async () => bundle.localInfo(),
    plan: (projectId, options) => bundle.buildPlan(projectId, options),
    preflight: (plan, options) => apply.preflight(plan, options),
    async makeBundle(projectId, options, outFile) {
      const stage = `${outFile}.stage`;
      fs.mkdirSync(stage, { recursive: true });
      try {
        await bundle.buildBundle({ projectId, options, dir: stage, log: job.log });
        const bytes = await bundle.packBundle(stage, outFile);
        return { file: outFile, bytes };
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    },
    applyBundle: (file, options) =>
      apply.applyBundle({ file, options, report: { log: job.log, step: job.step } }),
    quiesce: (projectId) => apply.quiesceProject(projectId),
    resume: (projectId) => apply.resumeProject(projectId),
    release: (projectId, options) => apply.releaseProject(projectId, options),
  };
}

function remoteSide(job, remote) {
  return {
    kind: 'remote',
    name: remote.name,
    info: async () => (await remote.hello()).server,
    plan: async (projectId, options) => (await remote.plan(projectId, options)).plan,
    preflight: async (plan, options) => (await remote.preflight(plan, options)).preflight,
    async makeBundle(projectId, options, outFile) {
      const res = await remote.bundle(projectId, options, outFile, (done, total) =>
        job.setProgress('Downloading the bundle', done, total)
      );
      job.progress = null;
      return { file: outFile, bytes: res.bytes };
    },
    async applyBundle(file, options) {
      const size = fs.statSync(file).size;
      job.setProgress('Uploading the bundle', 0, size);
      const { jobId } = await remote.apply(
        file,
        options,
        (done, total) => job.setProgress('Uploading the bundle', done, total),
        bundle.localInfo().hostname
      );
      job.progress = null;
      if (!jobId) throw new Error(`${remote.name} accepted the bundle but did not start an import`);
      return followRemoteJob(job, remote, jobId);
    },
    quiesce: (projectId) => remote.quiesce(projectId),
    resume: (projectId) => remote.resume(projectId),
    release: (projectId, options) => remote.release(projectId, options),
  };
}

/**
 * Mirror the other panel's import job into this one: its log lines and its
 * steps show up here, so the whole move reads as a single story.
 */
async function followRemoteJob(job, remote, remoteJobId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let since = 0;
  let quiet = 0;
  for (;;) {
    let snap;
    try {
      snap = (await remote.job(remoteJobId, since)).job;
      quiet = 0;
    } catch (e) {
      // A brief blip must not abandon an import that is already running.
      quiet += 1;
      if (quiet > 10) throw new Error(`lost contact with ${remote.name} while it was importing: ${e.message}`);
      await sleep(3000);
      continue;
    }
    for (const line of snap.logs || []) {
      since = Math.max(since, line.seq);
      job.log(`│ ${line.line}`, line.level === 'err' ? 'warn' : line.level, false);
    }
    for (const step of snap.steps || []) {
      const key = `remote:${step.key}`;
      const mirror = job.steps.find((s) => s.key === key);
      if (!mirror) {
        job.steps.push({ ...step, key, label: step.label, remote: true });
      } else {
        Object.assign(mirror, { status: step.status, detail: step.detail, finishedAt: step.finishedAt });
      }
      if (step.status === 'running') job.phase = step.label;
    }
    persist(job);
    if (TERMINAL.includes(snap.status)) {
      if (snap.status === 'failed') {
        throw new Error(snap.error || snap.result?.error || `the import failed on ${remote.name}`);
      }
      return snap.result || { ok: true, warnings: snap.warnings || [] };
    }
    await sleep(1500);
  }
}

/* ------------------------------------------------------------ orchestrator */


function remoteFor(serverId) {
  const row = store.getServerSecret(serverId);
  if (!row) throw new Error('That server is not linked any more');
  if (!row.password) {
    throw new Error(`The saved password for ${row.name} cannot be read (the panel's JWT_SECRET changed) — open Servers and enter it again.`);
  }
  return new Remote(row);
}

/**
 * Start a transfer. `direction` is 'push' (this server → linked server) or
 * 'pull' (linked server → this server). Returns the live job immediately;
 * the work continues in the background.
 */
export function startTransfer({ direction, serverId, projectId, options: optionsInput, projectName }) {
  const options = bundle.normalizeOptions(optionsInput);
  const remote = remoteFor(serverId);
  const server = store.getServer(serverId);

  const job = createJob({
    direction,
    serverId,
    serverName: server?.name || remote.base,
    serverUrl: remote.base,
    sourceProjectId: direction === 'push' ? projectId : null,
    remoteProjectId: direction === 'pull' ? projectId : null,
    projectName: projectName || '',
    options,
  });

  const source = direction === 'push' ? localSide(job) : remoteSide(job, remote);
  const dest = direction === 'push' ? remoteSide(job, remote) : localSide(job);

  run({ job, source, dest, projectId, options, remote, direction }).catch((err) => {
    job.log(err.message, 'err');
    const open = job.steps.find((s) => s.status === 'running');
    if (open) {
      open.status = 'fail';
      open.detail = err.message;
      open.finishedAt = nowIso();
    }
    job.error = err.message;
    finish(job, 'failed');
  });

  return job;
}

async function run({ job, source, dest, projectId, options, direction }) {
  const workdir = path.join(transfersDir(), job.id);
  fs.mkdirSync(workdir, { recursive: true });
  let stoppedSource = false;
  let released = false;

  try {
    /* 1. both ends ------------------------------------------------------- */
    {
      const end = job.step('connect', `Reach ${direction === 'push' ? dest.name : source.name}`);
      job.sourceInfo = await source.info();
      job.destInfo = await dest.info();
      const other = direction === 'push' ? job.destInfo : job.sourceInfo;
      if (Number(other?.protocol) !== bundle.PROTOCOL) {
        const why = `that panel speaks transfer protocol v${other?.protocol ?? '?'}, this one v${bundle.PROTOCOL} — update the older side`;
        end('fail', why);
        throw new Error(why);
      }
      end('ok', `${other.hostname} · node ${other.node} · projects in ${other.projectsRoot}`);
    }

    /* 2. what exactly moves ---------------------------------------------- */
    let plan;
    {
      const end = job.step('plan', 'Look at the project');
      plan = await source.plan(projectId, options);
      job.projectName = plan.project.name;
      job.plan = {
        project: plan.project,
        totals: plan.totals,
        services: plan.services.map((s) => ({ name: s.name, bytes: s.bytes, port: s.port, domains: s.domains, databases: s.databases })),
      };
      end(
        'ok',
        `${plan.project.name}: ${plan.totals.services} service(s), ${bundle.formatSize(plan.totals.bytes)}` +
          `${plan.totals.domains ? `, ${plan.totals.domains} domain(s)` : ''}` +
          `${plan.totals.databases ? `, ${plan.totals.databases} database(s)` : ''}`
      );
      for (const w of plan.warnings || []) job.log(`! ${w}`, 'warn');
      for (const n of plan.notes || []) job.log(n, 'note');
      // The bundle is staged on disk twice over (per-service archives, then
      // the single tar) before a byte leaves the source.
      if (source.kind === 'local') {
        const free = await bundle.freeBytes(config.dataDir);
        const need = Math.round(plan.totals.bytes * 2.1) + 64 * 1048576;
        if (free && free < need) {
          const why = `this server needs ${bundle.formatSize(need)} free to pack the project and has ${bundle.formatSize(free)}`;
          end('fail', why);
          throw new Error(why);
        }
      }
    }

    /* 3. is the destination ready? --------------------------------------- */
    {
      const end = job.step('check', `Check ${dest.name}`);
      const pre = await dest.preflight(plan, options);
      job.preflight = pre;
      if (!pre.ok) {
        const why = pre.blocking.map((b) => b.message).join(' · ');
        end('fail', why);
        throw new Error(why);
      }
      // The destination repeats this check right before it writes anything,
      // and THAT run is the one that reports — this early pass only exists
      // so a doomed transfer fails before a single byte moves.
      for (const p of pre.ports || []) {
        job.log(`port ${p.from} looks busy there (${p.by}) — ${p.service} may move to ${p.to}`);
      }
      end('ok', `ready: ${pre.target.path}`);
    }

    /* 4. freeze the source so nothing changes mid-copy ------------------- */
    if (options.stopSource) {
      const end = job.step('quiesce', 'Pause the project at the source');
      const res = await source.quiesce(projectId);
      stoppedSource = true;
      const stopped = (res.results || []).filter((r) => !r.skipped).length;
      end(res.ok ? 'ok' : 'warn', stopped ? `${stopped} process(es) stopped` : 'nothing was running');
    }

    /* 5. pack it up ------------------------------------------------------ */
    let bundleFile;
    {
      const end = job.step('bundle', direction === 'push' ? 'Pack the project' : 'Fetch the project');
      const res = await source.makeBundle(projectId, options, path.join(workdir, 'bundle.tar'));
      bundleFile = res.file;
      end('ok', bundle.formatSize(res.bytes || fs.statSync(bundleFile).size));
    }

    // A copy (not a move) gets its processes back right away — only a real
    // move leaves the source down, because it is about to disappear.
    if (stoppedSource && !options.removeSource) {
      const end = job.step('unpause', 'Start the project again at the source');
      try {
        await source.resume(projectId);
        stoppedSource = false;
        end('ok', 'the original is running again');
      } catch (e) {
        end('warn', e.message);
      }
    }

    /* 6. hand it over ---------------------------------------------------- */
    const result = await dest.applyBundle(bundleFile, options);
    job.result = result;
    if (result?.projectId && direction === 'pull') job.newProjectId = result.projectId;
    for (const w of result?.warnings || []) if (!job.warnings.includes(w)) job.warnings.push(w);
    for (const n of result?.notes || []) if (!job.notes.includes(n)) job.notes.push(n);

    /* 7. stand down at the source ---------------------------------------- */
    if (!options.removeSource) {
      job.step('release', 'Keep the original')('skipped', 'this was a copy — nothing was removed at the source');
    } else if (result?.ok) {
      const end = job.step('release', 'Remove the project from the source');
      try {
        const res = await source.release(projectId, options);
        released = true;
        end('ok', res.kept ? 'kept on request' : `${res.name || job.projectName} removed, domains and processes included`);
      } catch (e) {
        end('warn', `${e.message} — remove it by hand at the source`);
        job.pendingRelease = true;
      }
    } else {
      job.step('release', 'Remove the project from the source')(
        'skipped',
        'the project is not fully up on the other side — the original is left running'
      );
      job.pendingRelease = true;
      if (stoppedSource) {
        try {
          await source.resume(projectId);
          stoppedSource = false;
          job.log('The original was started again — nothing was deleted.', 'step');
        } catch (e) {
          job.log(`Could not restart the original: ${e.message}`, 'warn');
        }
      }
    }

    /* 8. what is left for a human ---------------------------------------- */
    const hosts = (plan.services || []).flatMap((s) => (s.domains || []).map((d) => d.host));
    if (options.domains && hosts.length) {
      const where = job.destInfo?.hostname
        ? `${job.destInfo.hostname}${job.destInfo.address ? ` (${job.destInfo.address})` : ''}`
        : dest.name;
      job.log(
        `Point the DNS of ${hosts.join(', ')} at ${where} — until that propagates, those names still resolve to the old server.`,
        'note'
      );
    }

    job.released = released;
    finish(job, job.warnings.length ? 'warning' : 'success');
  } catch (err) {
    // Whatever went wrong, the original must be left exactly as it was —
    // including running, if this transfer is what stopped it.
    if (stoppedSource && !released) {
      try {
        await source.resume(projectId);
        job.log('The original was started again — nothing was deleted.', 'step');
      } catch {
        job.log('The original could not be restarted — press Start on its project page.', 'warn');
      }
    }
    throw err;
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

/* --------------------------------------------- receiving an uploaded push */

/**
 * A linked server has uploaded a bundle: import it here as a job of its own
 * so the pusher can follow every step over the API.
 */
export function startApplyJob({ file, options: optionsInput, from }) {
  const options = bundle.normalizeOptions(optionsInput);
  const job = createJob({
    direction: 'incoming',
    serverName: from || 'another server',
    projectName: '',
    options,
  });

  (async () => {
    const result = await apply.applyBundle({
      file,
      options,
      report: { log: job.log, step: job.step },
    });
    job.result = result;
    job.projectName = result.projectName;
    job.newProjectId = result.projectId;
    for (const w of result.warnings || []) if (!job.warnings.includes(w)) job.warnings.push(w);
    for (const n of result.notes || []) if (!job.notes.includes(n)) job.notes.push(n);
    finish(job, job.warnings.length ? 'warning' : 'success');
  })()
    .catch((err) => {
      job.log(err.message, 'err');
      const open = job.steps.find((s) => s.status === 'running');
      if (open) {
        open.status = 'fail';
        open.detail = err.message;
        open.finishedAt = nowIso();
      }
      job.error = err.message;
      finish(job, 'failed');
    })
    .finally(() => {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.d`, { recursive: true, force: true });
    });

  return job;
}

/**
 * Finish a move whose destination came up but whose source was deliberately
 * left alone (a failed deploy, a lost connection). One button, after the
 * operator has seen for themselves that the new copy works.
 */
export async function releaseSourceNow(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error('Transfer not found');
  if (!job.pendingRelease) throw new Error('This transfer has nothing left to remove at the source');
  const options = { ...bundle.normalizeOptions(job.options), removeSource: true };

  const live = JOBS.get(jobId);
  const log = live?.log || (() => {});
  if (job.direction === 'push') {
    const res = await apply.releaseProject(job.sourceProjectId, options);
    log(`✓ Removed ${res.name || job.projectName} from this server`, 'step');
  } else {
    const remote = remoteFor(job.serverId);
    await remote.release(job.remoteProjectId, options);
    log(`✓ Removed ${job.projectName} from ${job.serverName}`, 'step');
  }

  const target = live || job;
  target.pendingRelease = false;
  target.released = true;
  if (live) {
    live.steps.push({ key: 'release-late', label: 'Remove the project from the source', status: 'ok', detail: 'done afterwards, on request', startedAt: nowIso(), finishedAt: nowIso() });
    persist(live);
  } else {
    store.saveTransfer({ ...job, pendingRelease: false, released: true });
  }
  return { ok: true };
}
