import os from 'node:os';
import { list as pm2List } from './pm2.js';

/**
 * Lightweight metrics built on top of the CLI-based pm2 service (no IPC API).
 * We keep a short rolling history of each pm2 process's CPU and memory so the
 * UI can draw Railway-style sparklines without a time-series DB.
 */

const HISTORY = new Map(); // pm2Name -> [{ t, cpu, memory }]
const MAX_POINTS = 60;

// Concurrency guard: many callers (the 2s global sampler, every open metrics
// tab, the /processes route) ask for a sample at once. Sharing one in-flight
// `pm2 jlist` prevents a slow daemon from fanning out overlapping children —
// the exact pile-up that can wedge the box under load.
let inFlight = null;

export async function sampleOnce() {
  if (inFlight) return inFlight;
  inFlight = doSample().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSample() {
  // pm2List never throws and returns [] if the daemon is down.
  const procs = await pm2List();
  const t = Date.now();
  const seen = new Set();
  const points = procs.map((p) => {
    seen.add(p.name);
    const point = { name: p.name, cpu: p.cpu ?? 0, memory: p.memory ?? 0 };
    const hist = HISTORY.get(p.name) || [];
    hist.push({ t, cpu: point.cpu, memory: point.memory });
    while (hist.length > MAX_POINTS) hist.shift();
    HISTORY.set(p.name, hist);
    return point;
  });
  // Prune history for processes that no longer exist (stopped/deleted/renamed)
  // so the Map can't grow without bound on a long-running server.
  // Guard against an empty result from a transient daemon outage wiping
  // everything: only prune when we actually saw some processes.
  if (seen.size) {
    for (const key of HISTORY.keys()) if (!seen.has(key)) HISTORY.delete(key);
  }
  return points;
}

export function getHistory(pm2Name) {
  return HISTORY.get(pm2Name) || [];
}

export function systemStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const load = os.loadavg(); // [1m, 5m, 15m]
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    cpus: os.cpus().length,
    uptime: os.uptime(),
    load,
    memory: { total, free, used: total - free },
  };
}
