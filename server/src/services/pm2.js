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

/**
 * Extract the JSON array from `pm2 jlist` stdout. pm2 can prefix lines like
 * "[PM2] Spawning PM2 daemon..." — a naive indexOf('[') would land inside
 * such a banner and break JSON.parse. We try parsing the whole output first,
 * then fall back to the last line that actually parses as an array.
 */
function parseJlist(stdout) {
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  // Fast path: clean JSON output.
  const whole = tryParse(stdout.trim());
  if (whole) return whole;
  // Banner present: the array is the longest line that parses as an array.
  // pm2 jlist prints the array on a single line, so scan lines back-to-front.
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('[') && !lines[i].startsWith('[PM2]')) {
      const arr = tryParse(lines[i]);
      if (arr) return arr;
    }
  }
  return [];
}

/** Parse `pm2 jlist` output. Returns [] on any error (daemon down, etc.). */
export async function list() {
  const res = await run('pm2', ['jlist'], { timeout: 10000 });
  if (res.code !== 0) return [];
  return parseJlist(res.stdout).map(shapeFromJlist);
}

async function action(args) {
  const res = await run('pm2', args, { timeout: 30000 });
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || 'pm2 command failed').trim());
  }
  return true;
}

export function restart(idOrName) {
  // No --update-env: a generic restart must keep the env the process was
  // originally started with. With it, pm2 would stamp *this panel's* env
  // (its PORT, secrets) onto whatever process the user restarts.
  return action(['restart', String(idOrName)]);
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
