import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { list as pm2List } from './pm2.js';
import { run } from './exec.js';
import { config } from '../config.js';

/**
 * Metrics built on top of the CLI-based pm2 service (no IPC API).
 *
 * Two layers:
 *  - Live: a short in-memory rolling window per process (sparklines).
 *  - History: hourly aggregates persisted to one JSON file per month in
 *    data/metrics/YYYY-MM.json — { procs: { name: [point] }, system: [point] }.
 *    A point is { t, cpu, cpuMax, mem, memMax } (+ disk/rx/tx for system).
 *    Kept for KEEP_MONTHS months so the UI can browse history by month.
 */

const HISTORY = new Map(); // pm2Name -> [{ t, cpu, memory }]
const MAX_POINTS = 60;
const SYS_WINDOW = []; // rolling live window of system samples [{ t, cpu, mem, rx, tx }]

const METRICS_DIR = path.join(config.dataDir, 'metrics');
const KEEP_MONTHS = 12;
const SYSTEM_KEY = '__system__';
const PARTIAL_FLUSH_MS = 5 * 60 * 1000; // persist the running hour every 5 min

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

/* ------------------------------------------------- system: disk & network */

let prevNet = null; // { t, rx, tx }
let netRates = { rxSec: 0, txSec: 0 };

function readNetTotals() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const [iface, rest] = line.split(':');
      if (!rest || iface.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/);
      rx += Number(f[0]) || 0; // bytes received
      tx += Number(f[8]) || 0; // bytes transmitted
    }
    return { rx, tx };
  } catch {
    return null; // non-Linux or unreadable — bandwidth just stays 0
  }
}

function sampleNet(t) {
  const now = readNetTotals();
  if (!now) return;
  if (prevNet && t > prevNet.t) {
    const dt = (t - prevNet.t) / 1000;
    // counters reset on reboot / interface flap — clamp negatives
    netRates = {
      rxSec: Math.max(0, Math.round((now.rx - prevNet.rx) / dt)),
      txSec: Math.max(0, Math.round((now.tx - prevNet.tx) / dt)),
    };
  }
  prevNet = { t, ...now };
}

function diskStats() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

/* --------------------------------------------- hourly buckets -> monthly */

let bucketHour = null; // start-of-hour ms the current bucket aggregates
let bucket = new Map(); // name -> { cpuSum, cpuMax, memSum, memMax, n, ...sys }
let domainBucket = new Map(); // host -> { req, bytes, s2, s3, s4, s5 } (traffic.js feeds this)
let lastPartialFlush = 0;

const hourStart = (t) => {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};
const monthKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function accumulate(name, cpu, mem, extras) {
  const b = bucket.get(name) || { cpuSum: 0, cpuMax: 0, memSum: 0, memMax: 0, n: 0 };
  b.cpuSum += cpu;
  b.cpuMax = Math.max(b.cpuMax, cpu);
  b.memSum += mem;
  b.memMax = Math.max(b.memMax, mem);
  b.n++;
  if (extras) {
    b.rxSum = (b.rxSum || 0) + extras.rxSec;
    b.txSum = (b.txSum || 0) + extras.txSec;
    b.disk = extras.disk; // latest snapshot wins
  }
  bucket.set(name, b);
}

/** One parsed nginx access-log line for a managed domain (from traffic.js). */
export function accumulateDomain(host, status, bytes) {
  const b = domainBucket.get(host) || { req: 0, bytes: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
  b.req++;
  b.bytes += bytes;
  const cls = Math.floor(status / 100);
  if (cls === 2) b.s2++;
  else if (cls === 3) b.s3++;
  else if (cls === 4) b.s4++;
  else if (cls >= 5) b.s5++;
  domainBucket.set(host, b);
}

/** Insert or replace the point for this hour (partial flushes re-write it). */
function upsertPoint(arr, point) {
  const last = arr[arr.length - 1];
  if (last && last.t === point.t) arr[arr.length - 1] = point;
  else arr.push(point);
}

function flushBucket(hourDone) {
  if (bucketHour === null || (!bucket.size && !domainBucket.size)) return;
  const file = path.join(METRICS_DIR, `${monthKey(bucketHour)}.json`);
  let data = { procs: {}, system: [] };
  try {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* corrupted file — start over rather than crash the sampler */
  }
  data.procs ||= {};
  data.system ||= [];
  data.domains ||= {};

  for (const [name, b] of bucket) {
    const point = {
      t: bucketHour,
      cpu: +(b.cpuSum / b.n).toFixed(1),
      cpuMax: +b.cpuMax.toFixed(1),
      mem: Math.round(b.memSum / b.n),
      memMax: b.memMax,
    };
    if (name === SYSTEM_KEY) {
      point.rx = Math.round((b.rxSum || 0) / b.n);
      point.tx = Math.round((b.txSum || 0) / b.n);
      point.disk = b.disk || null;
      upsertPoint(data.system, point);
    } else {
      data.procs[name] ||= [];
      upsertPoint(data.procs[name], point);
    }
  }

  for (const [host, b] of domainBucket) {
    data.domains[host] ||= [];
    upsertPoint(data.domains[host], { t: bucketHour, ...b });
  }

  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    /* disk hiccup — next flush retries */
  }
  if (hourDone) {
    bucket = new Map();
    domainBucket = new Map();
  }
  pruneOldMonths();
}

function pruneOldMonths() {
  try {
    const files = fs
      .readdirSync(METRICS_DIR)
      .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(KEEP_MONTHS)) fs.unlinkSync(path.join(METRICS_DIR, f));
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- sampler */

async function doSample() {
  // pm2List never throws and returns [] if the daemon is down.
  const procs = await pm2List();
  const t = Date.now();
  sampleNet(t);

  const h = hourStart(t);
  if (bucketHour !== null && h !== bucketHour) flushBucket(true); // hour rolled over
  bucketHour = h;

  const seen = new Set();
  const points = procs.map((p) => {
    seen.add(p.name);
    const point = { name: p.name, cpu: p.cpu ?? 0, memory: p.memory ?? 0 };
    const hist = HISTORY.get(p.name) || [];
    hist.push({ t, cpu: point.cpu, memory: point.memory });
    while (hist.length > MAX_POINTS) hist.shift();
    HISTORY.set(p.name, hist);
    accumulate(p.name, point.cpu, point.memory);
    return point;
  });

  // System-wide point: load-based CPU %, used RAM, disk snapshot, net rates.
  const cpus = os.cpus().length || 1;
  const sysCpu = Math.min(100, (os.loadavg()[0] / cpus) * 100);
  const usedMem = os.totalmem() - os.freemem();
  accumulate(SYSTEM_KEY, sysCpu, usedMem, {
    ...netRates,
    disk: diskStats(),
  });
  SYS_WINDOW.push({ t, cpu: +sysCpu.toFixed(1), mem: usedMem, rx: netRates.rxSec, tx: netRates.txSec });
  while (SYS_WINDOW.length > MAX_POINTS) SYS_WINDOW.shift();

  if (t - lastPartialFlush >= PARTIAL_FLUSH_MS) {
    flushBucket(false);
    lastPartialFlush = t;
  }

  // Prune history for processes that no longer exist (stopped/deleted/renamed)
  // so the Map can't grow without bound on a long-running server.
  // Guard against an empty result from a transient daemon outage wiping
  // everything: only prune when we actually saw some processes.
  if (seen.size) {
    for (const key of HISTORY.keys()) if (!seen.has(key)) HISTORY.delete(key);
  }
  return points;
}

/* ------------------------------------------------------------- public API */

export function getHistory(pm2Name) {
  return HISTORY.get(pm2Name) || [];
}

/** Live rolling window of system-wide samples (2s cadence, ~2 minutes). */
export function getSystemWindow() {
  return SYS_WINDOW;
}

/** Months that have persisted history, newest first: ['2026-07', ...] */
export function listMonths() {
  try {
    return fs
      .readdirSync(METRICS_DIR)
      .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 7))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function readMonth(month) {
  try {
    return JSON.parse(fs.readFileSync(path.join(METRICS_DIR, `${month}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** Hourly points for one process + the system series for a given month. */
export function getMonthHistory(month, pm2Name) {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const data = readMonth(month);
  return { points: data?.procs?.[pm2Name] || [], system: data?.system || [] };
}

/** System-wide hourly series for a given month. */
export function getMonthSystem(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  return readMonth(month)?.system || [];
}

/** Hourly traffic for a set of domains in a month, summed per hour. */
export function getMonthDomains(month, hosts) {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const domains = readMonth(month)?.domains || {};
  const byT = new Map();
  for (const h of hosts) {
    for (const p of domains[h] || []) {
      const a = byT.get(p.t) || { t: p.t, req: 0, bytes: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
      a.req += p.req || 0;
      a.bytes += p.bytes || 0;
      a.s2 += p.s2 || 0;
      a.s3 += p.s3 || 0;
      a.s4 += p.s4 || 0;
      a.s5 += p.s5 || 0;
      byT.set(p.t, a);
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * Size of a service's folder on disk (`du -sb`), cached for a minute —
 * node_modules-heavy folders make du too slow to run per request.
 */
const duCache = new Map(); // path -> { t, bytes }
const DU_TTL = 60 * 1000;

export async function dirSize(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return 0;
  const hit = duCache.get(dirPath);
  if (hit && Date.now() - hit.t < DU_TTL) return hit.bytes;
  // -sk = allocated blocks (real space occupied), not apparent file size
  const res = await run('du', ['-sk', dirPath], { timeout: 20000 });
  const kb = res.code === 0 ? Number(res.stdout.trim().split(/\s+/)[0]) || 0 : (hit?.bytes || 0) / 1024;
  const bytes = kb * 1024;
  duCache.set(dirPath, { t: Date.now(), bytes });
  return bytes;
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
    disk: diskStats(),
    net: netRates,
  };
}
