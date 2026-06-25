import fs from 'node:fs';
import path from 'node:path';
import { runStream } from './exec.js';
import * as store from '../store.js';
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

  // 2. Write env vars -----------------------------------------------------
  writeEnvFile(service, workdir, log);

  // 3. Build --------------------------------------------------------------
  if (service.buildCommand && service.buildCommand.trim()) {
    setStatus('building');
    log(`==> Build: ${service.buildCommand}`);
    const code = await runStream(
      service.buildCommand, [], { cwd: workdir, shell: true }, onLine
    );
    if (code !== 0) return setStatus('failed');
  }

  // 4. Release (pm2 start or restart) ------------------------------------
  setStatus('deploying');
  const pm2Name = service.pm2Name || service.name;
  const startCmd = (service.startCommand || '').trim();

  if (startCmd) {
    // Is the process already known to pm2? Restart it; otherwise start fresh.
    const desc = await runStream('pm2', ['describe', pm2Name], {}, () => {});
    if (desc === 0) {
      log(`==> Restarting pm2 process: ${pm2Name}`);
      const code = await runStream('pm2', ['restart', pm2Name, '--update-env'], {}, onLine);
      if (code !== 0) return setStatus('failed');
    } else {
      log(`==> Starting pm2 process: ${pm2Name}`);
      // `pm2 start "cmd" --name x` runs an arbitrary start command.
      const code = await runStream(
        'pm2',
        ['start', startCmd, '--name', pm2Name],
        { cwd: workdir, shell: false },
        onLine
      );
      if (code !== 0) return setStatus('failed');
    }
  } else if (pm2Name) {
    log(`==> Restarting pm2 process: ${pm2Name}`);
    await runStream('pm2', ['restart', pm2Name, '--update-env'], {}, onLine);
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
