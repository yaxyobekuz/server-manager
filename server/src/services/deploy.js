import fs from 'node:fs';
import path from 'node:path';
import { runStream } from './exec.js';
import * as store from '../store.js';
import { describe as pm2Describe } from './pm2.js';
import { detectProject } from './detect.js';
import { emitDeployLog, emitDeployStatus } from './bus.js';

/**
 * Railway-style deployment engine.
 *
 * A deployment goes through: building -> deploying -> success/failed.
 * Each step streams its output to (a) the persisted deployment log and
 * (b) the live WebSocket bus so any open UI sees it in real time.
 */

function resolveWorkdir(service) {
  // Where the code lives / will live on the VPS.
  if (service.localPath) {
    return service.rootDirectory
      ? path.join(service.localPath, service.rootDirectory)
      : service.localPath;
  }
  return '';
}

// The panel's own config (its PORT, admin password, secrets) must never
// reach a deployed app: pm2 snapshots the spawner's env, and dotenv in the
// app then silently ignores the same keys in the service's .env — e.g. the
// app binds the panel's PORT instead of its own and crash-loops.
const PANEL_ONLY_VARS = ['PORT', 'ADMIN_PASSWORD', 'JWT_SECRET', 'JWT_EXPIRES_IN', 'GITHUB_WEBHOOK_SECRET'];

function serviceEnv(service) {
  const env = { ...process.env };
  for (const k of PANEL_ONLY_VARS) delete env[k];
  Object.assign(env, service.variables || {});
  return env;
}

/**
 * Effective deploy config: what the user set in Settings, with blanks filled
 * by auto-detection (framework sniffing in the checked-out code). Detected
 * values are persisted so the UI shows what the service resolved to.
 */
function resolveRuntime(service, workdir, log) {
  let kind = service.serviceKind || 'auto';
  let buildCommand = service.buildCommand || '';
  let startCommand = service.startCommand || '';
  let outputDir = service.staticOutputDir || '';

  // Detect whenever ANY needed field is blank — a user who sets only the
  // start command still expects the build step (npm install) to be inferred.
  const needsDetection =
    kind === 'auto' ||
    !buildCommand ||
    (kind !== 'static' && !startCommand) ||
    (kind === 'static' && !outputDir);
  if (needsDetection && workdir && fs.existsSync(workdir)) {
    const d = detectProject(workdir);
    log(`==> Detected project type: ${d.kind} — ${d.reason}`);
    if (kind === 'auto') kind = d.kind;
    if (!buildCommand) buildCommand = d.buildCommand;
    if (!startCommand) startCommand = d.startCommand;
    if (!outputDir) outputDir = d.outputDir;
    store.updateService(service.id, {
      serviceKind: kind,
      buildCommand,
      ...(kind === 'backend' ? { startCommand } : {}),
      ...(kind === 'static' ? { staticOutputDir: outputDir } : {}),
    });
  }
  if (kind === 'auto') kind = 'backend'; // nothing to detect against — old behavior
  return { kind, buildCommand, startCommand, outputDir };
}

function writeEnvFile(service, workdir, log) {
  const vars = service.variables || {};
  const keys = Object.keys(vars);
  if (!keys.length || !workdir) return;
  const body = keys.map((k) => `${k}=${vars[k]}`).join('\n') + '\n';
  try {
    fs.writeFileSync(path.join(workdir, '.env'), body);
    log(`==> Wrote ${keys.length} variable(s) to .env`);
  } catch (e) {
    log(`==> Could not write .env: ${e.message}`, 'stderr');
  }
}

const STABILITY_WAIT_MS = 5000;

/**
 * A freshly (re)created process starts with restarts=0. If it is anything
 * but `online` with 0 restarts after the wait, it is crash-looping — grab
 * the tail of its error log so the deploy log shows WHY.
 */
async function checkStability(pm2Name, log) {
  log('==> Verifying the process stays up…');
  await new Promise((r) => setTimeout(r, STABILITY_WAIT_MS));
  const proc = await pm2Describe(pm2Name);
  const ok = !!proc && proc.status === 'online' && (proc.restarts ?? 0) === 0;
  let errTail = [];
  if (!ok && proc?.errLogPath) {
    try {
      errTail = fs.readFileSync(proc.errLogPath, 'utf8').trim().split('\n').slice(-15);
    } catch {
      /* log file may not exist yet */
    }
  }
  return {
    ok,
    status: proc?.status || 'not found',
    restarts: proc?.restarts ?? 0,
    pid: proc?.pid,
    errTail,
  };
}

export async function runDeployment(service, deployment, { trigger } = {}) {
  const dId = deployment.id;

  const log = (line, stream = 'stdout') => {
    store.appendDeploymentLog(dId, { stream, line });
    emitDeployLog(service.id, dId, { stream, line });
  };
  const onLine = (p) => log(p.line, p.stream);

  const setStatus = (status) => {
    store.setDeploymentStatus(dId, status);
    emitDeployStatus(service.id, dId, status);
  };

  log(`╭─ Deployment started (${trigger || 'manual'})`);

  const workdir = resolveWorkdir(service);

  // 1. Fetch source -------------------------------------------------------
  if (service.sourceType === 'github' && service.repoUrl) {
    if (!service.localPath) {
      log('Service has no local path on the VPS — set one in Settings.', 'stderr');
      setStatus('failed');
      return;
    }
    const repoExists = fs.existsSync(path.join(service.localPath, '.git'));
    if (!repoExists) {
      log(`==> Cloning ${service.repoUrl} (${service.branch})`);
      if (!fs.existsSync(service.localPath)) fs.mkdirSync(service.localPath, { recursive: true });
      const code = await runStream(
        'git',
        ['clone', '-b', service.branch, service.repoUrl, service.localPath],
        {}, onLine
      );
      if (code !== 0) return setStatus('failed');
    } else {
      log(`==> Pulling ${service.branch}`);
      const f = await runStream('git', ['fetch', 'origin'], { cwd: service.localPath }, onLine);
      if (f !== 0) return setStatus('failed');
      const r = await runStream(
        'git', ['reset', '--hard', `origin/${service.branch}`],
        { cwd: service.localPath }, onLine
      );
      if (r !== 0) return setStatus('failed');
    }
  } else {
    log(`==> Using local source at ${workdir || service.localPath || '(unset)'}`);
  }

  // 2. Resolve how to build/run (auto-detect fills blanks) ---------------
  const runtime = resolveRuntime(service, workdir, log);

  // 3. Write env vars -----------------------------------------------------
  writeEnvFile(service, workdir, log);

  // 4. Build --------------------------------------------------------------
  if (runtime.buildCommand && runtime.buildCommand.trim()) {
    setStatus('building');
    log(`==> Build: ${runtime.buildCommand}`);
    const code = await runStream(
      runtime.buildCommand, [],
      { cwd: workdir, shell: true, replaceEnv: serviceEnv(service) },
      onLine
    );
    if (code !== 0) return setStatus('failed');
  }

  // 5. Release ------------------------------------------------------------
  setStatus('deploying');

  if (runtime.kind === 'static') {
    // Static sites need no process: nginx serves the build output directly.
    const outPath = path.resolve(workdir || '/', runtime.outputDir || '');
    if (!fs.existsSync(path.join(outPath, 'index.html'))) {
      log(`Static output not found: ${path.join(outPath, 'index.html')} — check the build command and output directory in Settings.`, 'stderr');
      return setStatus('failed');
    }
    log(`==> Static site ready at ${outPath} (served by nginx — no pm2 process)`);
    log('╰─ Deployment successful ✓');
    store.supersedeActiveDeployments(service.id, dId);
    setStatus('success');
    return;
  }

  const pm2Name = service.pm2Name || service.name;
  const startCmd = (runtime.startCommand || '').trim();

  if (startCmd) {
    // pm2 `restart` re-runs whatever command the process was FIRST started
    // with — a changed start command or cwd in Settings would silently never
    // apply. Recreate the process instead so every deploy runs the current
    // settings against the current checkout.
    const desc = await runStream('pm2', ['describe', pm2Name], {}, () => {});
    if (desc === 0) {
      log(`==> Replacing pm2 process: ${pm2Name}`);
      await runStream('pm2', ['delete', pm2Name], {}, () => {});
    } else {
      log(`==> Starting pm2 process: ${pm2Name}`);
    }
    const code = await runStream(
      'pm2',
      ['start', startCmd, '--name', pm2Name],
      { cwd: workdir, shell: false, replaceEnv: serviceEnv(service) },
      onLine
    );
    if (code !== 0) return setStatus('failed');
    await runStream('pm2', ['save'], {}, () => {});

    // pm2 start "succeeds" even when the app dies instantly — verify the
    // process actually stays up, and surface its crash output in THIS log
    // instead of burying it in pm2's log files.
    const health = await checkStability(pm2Name, log);
    if (!health.ok) {
      log(`Process did not stay up (status: ${health.status}, restarts: ${health.restarts}).`, 'stderr');
      if (health.errTail.length) {
        log('==> Last lines of the process error log:', 'stderr');
        for (const line of health.errTail) log(line, 'stderr');
      }
      return setStatus('failed');
    }
    log(`==> Process online (pid ${health.pid}, 0 restarts after ${STABILITY_WAIT_MS / 1000}s)`);
  } else if (pm2Name) {
    log(`==> Restarting pm2 process: ${pm2Name}`);
    await runStream(
      'pm2', ['restart', pm2Name, '--update-env'],
      { replaceEnv: serviceEnv(service) },
      onLine
    );
  }

  log('╰─ Deployment successful ✓');
  store.supersedeActiveDeployments(service.id, dId);
  setStatus('success');
}

/** Create a deployment record and run it in the background. */
export function startDeployment(service, { trigger = 'manual', commit = null } = {}) {
  const deployment = store.createDeployment(service.id, { trigger, commit });
  emitDeployStatus(service.id, deployment.id, 'building');
  // fire and forget; logs stream over the bus
  runDeployment(service, deployment, { trigger }).catch((e) => {
    store.appendDeploymentLog(deployment.id, { stream: 'stderr', line: e.message });
    store.setDeploymentStatus(deployment.id, 'failed');
    emitDeployStatus(service.id, deployment.id, 'failed');
  });
  return deployment;
}
