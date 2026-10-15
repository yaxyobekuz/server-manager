import os from 'node:os';
import fs from 'node:fs';
import { run } from './exec.js';

/**
 * Everything the Information page shows: static server facts (collected once
 * per process lifetime), live resource numbers, and an on-demand internet
 * speed test measured against Cloudflare from the server itself.
 */

/* ------------------------------------------------------------ static facts */

let staticInfo = null; // { os, versions } — never changes while we run
let publicNet = null; // { ip, colo } — cached after first successful lookup

async function toolVersion(cmd, args) {
  const r = await run(cmd, args, { timeout: 10000 });
  // nginx prints its version to stderr
  const out = `${r.stdout} ${r.stderr}`.trim();
  const m = out.match(/(\d+\.\d+[\d.]*)/);
  return m ? m[1] : null;
}

async function collectStatic() {
  let osName = `${os.type()} ${os.release()}`;
  try {
    const m = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) osName = m[1];
  } catch {
    /* non-standard distro — keep the kernel string */
  }
  const [npm, pm2, nginx, certbot, git] = await Promise.all([
    toolVersion('npm', ['-v']),
    toolVersion('pm2', ['-v']),
    toolVersion('nginx', ['-v']),
    toolVersion('certbot', ['--version']),
    toolVersion('git', ['--version']),
  ]);
  return {
    os: osName,
    versions: { node: process.version.slice(1), npm, pm2, nginx, certbot, git },
  };
}

/** Public IP + Cloudflare colo, via the same endpoint the speed test uses. */
async function publicNetwork() {
  if (publicNet) return publicNet;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('https://speed.cloudflare.com/cdn-cgi/trace', { signal: ctrl.signal });
    const text = await res.text();
    clearTimeout(timer);
    const pick = (k) => text.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1] || null;
    publicNet = { ip: pick('ip'), colo: pick('colo') };
  } catch {
    publicNet = null; // offline / blocked — retry on the next request
    return { ip: null, colo: null };
  }
  return publicNet;
}

/* ------------------------------------------------------------ live numbers */

function swapStats() {
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
    const total = kb('SwapTotal');
    const free = kb('SwapFree');
    return { total, free, used: total - free };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

/** Real (device-backed) filesystems from df, largest first. */
async function diskList() {
  const r = await run('df', ['-kP'], { timeout: 15000 });
  const disks = [];
  for (const line of (r.stdout || '').split('\n').slice(1)) {
    const m = line.match(/^(\/dev\/\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(\/.*)$/);
    if (!m) continue;
    disks.push({
      device: m[1],
      mount: m[5],
      total: Number(m[2]) * 1024,
      used: Number(m[3]) * 1024,
      free: Number(m[4]) * 1024,
    });
  }
  disks.sort((a, b) => b.total - a.total);
  return disks;
}

function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal || a.family !== 'IPv4') continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

export async function getInfo() {
  if (!staticInfo) staticInfo = await collectStatic();
  const [disks, net] = await Promise.all([diskList(), publicNetwork()]);
  const total = os.totalmem();
  const free = os.freemem();
  return {
    server: {
      hostname: os.hostname(),
      os: staticInfo.os,
      kernel: os.release(),
      arch: os.arch(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      time: new Date().toISOString(),
      uptime: os.uptime(),
      panelUptime: Math.floor(process.uptime()),
    },
    cpu: {
      model: os.cpus()[0]?.model || 'unknown',
      cores: os.cpus().length,
      speedMHz: os.cpus()[0]?.speed || 0,
      load: os.loadavg(),
    },
    memory: { total, free, used: total - free, swap: swapStats() },
    disks,
    network: { publicIp: net.ip, colo: net.colo, interfaces: interfaces() },
    software: staticInfo.versions,
  };
}

/* ------------------------------------------------------------- speed test
 * Measured against Cloudflare's speed endpoints from the server itself.
 * One phase at a time server-wide — parallel tests would skew each other's
 * numbers and burn bandwidth for nothing.
 */

const CF = 'https://speed.cloudflare.com';
let runningPhase = null;

export async function speedtest(phase) {
  if (runningPhase) {
    const err = new Error(`A speed test is already running (${runningPhase})`);
    err.busy = true;
    throw err;
  }
  runningPhase = phase;
  try {
    if (phase === 'ping') return await pingTest();
    if (phase === 'download') return await downloadTest();
    if (phase === 'upload') return await uploadTest();
    throw new Error('Unknown phase');
  } finally {
    runningPhase = null;
  }
}

async function pingTest() {
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    const res = await fetch(`${CF}/__down?bytes=0`, { cache: 'no-store' });
    await res.arrayBuffer();
    // the first round-trip pays DNS + TLS setup — measure the steady state
    if (i > 0) samples.push(performance.now() - t0);
  }
  let jitter = 0;
  for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i] - samples[i - 1]);
  jitter /= samples.length - 1;
  return {
    ms: +Math.min(...samples).toFixed(1),
    avg: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(1),
    jitter: +jitter.toFixed(1),
  };
}

/**
 * Stream 50 MB chunks on a fixed clock — Cloudflare rejects single requests
 * bigger than that with a 403, so a fast link just fetches more chunks.
 */
async function downloadTest() {
  const CHUNK = 50_000_000;
  const DURATION = 8000;
  const t0 = performance.now();
  let bytes = 0;
  while (performance.now() - t0 < DURATION) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DURATION - (performance.now() - t0));
    try {
      const res = await fetch(`${CF}/__down?bytes=${CHUNK}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Cloudflare answered HTTP ${res.status}`);
      for await (const chunk of res.body) bytes += chunk.length;
    } catch (err) {
      if (!ctrl.signal.aborted) throw err; // our own timed abort is the normal finish
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  const secs = (performance.now() - t0) / 1000;
  if (!bytes) throw new Error('Download test received no data');
  return { bytes, secs: +secs.toFixed(2), mbps: +((bytes * 8) / secs / 1e6).toFixed(1) };
}

/** Fixed-size upload; re-run with a bigger body when the link is fast. */
async function uploadTest() {
  const once = async (mb) => {
    const body = Buffer.alloc(mb * 1024 * 1024, 0x61);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const t0 = performance.now();
    try {
      const res = await fetch(`${CF}/__up`, { method: 'POST', body, signal: ctrl.signal });
      await res.arrayBuffer();
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error('Upload timed out (>30s) — the uplink is extremely slow or blocked');
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const secs = (performance.now() - t0) / 1000;
    return { bytes: body.length, secs, mbps: (body.length * 8) / secs / 1e6 };
  };
  let r = await once(10);
  if (r.secs < 1.5) r = await once(50);
  return { bytes: r.bytes, secs: +r.secs.toFixed(2), mbps: +r.mbps.toFixed(1) };
}
