import { run } from './exec.js';

/**
 * PM2 access via the CLI (`pm2 jlist`, `pm2 restart`, ...).
 *
 * We deliberately avoid the pm2 *programmatic* API (`pm2.connect()`): under
 * repeated connect/disconnect cycles — e.g. a metrics poller every 2s plus
 * user actions — its internal IPC channel can be torn down mid-message and
 * Node throws an UNCATCHABLE `kPendingMessages` TypeError that crashes the
 * whole server. Each CLI call is an isolated child process, so a PM2 hiccup
 * can never take the platform down with it.
 */

function shapeFromJlist(proc) {
  const env = proc.pm2_env || {};
  const monit = proc.monit || {};
  return {
    id: proc.pm_id,
    name: proc.name,
    pid: proc.pid,
    status: env.status, // online | stopped | errored | ...
    mode: env.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
    restarts: env.restart_time ?? 0,
    uptime: env.pm_uptime ?? null,
    cpu: monit.cpu ?? 0,
    memory: monit.memory ?? 0, // bytes
    cwd: env.pm_cwd || '',
    script: env.pm_exec_path || '',
  };
}

/** Parse `pm2 jlist` output. Returns [] on any error (daemon down, etc.). */
export async function list() {
  const res = await run('pm2', ['jlist'], { timeout: 10000 });
  if (res.code !== 0) return [];
  // jlist prints JSON to stdout; some pm2 versions emit a banner first, so
  // slice from the first '['.
  const start = res.stdout.indexOf('[');
  if (start === -1) return [];
  try {
    const arr = JSON.parse(res.stdout.slice(start));
    return Array.isArray(arr) ? arr.map(shapeFromJlist) : [];
  } catch {
    return [];
  }
}

async function action(args) {
  const res = await run('pm2', args, { timeout: 30000 });
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || 'pm2 command failed').trim());
  }
  return true;
}

export function restart(idOrName) {
  return action(['restart', String(idOrName), '--update-env']);
}

export function stop(idOrName) {
  return action(['stop', String(idOrName)]);
}

export function start(idOrName) {
  // An already-known but stopped process comes back online via restart.
  return action(['restart', String(idOrName)]);
}

export function deleteProc(idOrName) {
  return action(['delete', String(idOrName)]);
}

/** Describe a single process (used for the service metrics view). */
export async function describe(idOrName) {
  const all = await list();
  return all.find((p) => p.name === String(idOrName) || String(p.id) === String(idOrName)) || null;
}
