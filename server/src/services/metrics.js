import os from 'node:os';
import { list as pm2List } from './pm2.js';

/**
 * Lightweight metrics built on top of the CLI-based pm2 service (no IPC API).
 * We keep a short rolling history of each pm2 process's CPU and memory so the
 * UI can draw Railway-style sparklines without a time-series DB.
 */

const HISTORY = new Map(); // pm2Name -> [{ t, cpu, memory }]
const MAX_POINTS = 60;

export async function sampleOnce() {
  // pm2List never throws and returns [] if the daemon is down.
  const procs = await pm2List();
  const t = Date.now();
  return procs.map((p) => {
    const point = { name: p.name, cpu: p.cpu ?? 0, memory: p.memory ?? 0 };
    const hist = HISTORY.get(p.name) || [];
    hist.push({ t, cpu: point.cpu, memory: point.memory });
    while (hist.length > MAX_POINTS) hist.shift();
    HISTORY.set(p.name, hist);
    return point;
  });
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
