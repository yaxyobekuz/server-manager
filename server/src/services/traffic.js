import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import * as store from '../store.js';
import { accumulateDomain } from './metrics.js';
import { logPathFor } from './nginx.js';

/**
 * HTTP traffic metrics for managed domains, built from per-domain nginx
 * access logs (log_format sm_metrics, written by nginx.js).
 *
 * A 60s collector tails each domain's log incrementally and keeps:
 *  - a per-minute rolling window (last 60 min) for the live view,
 *  - top requested paths for the current hour,
 * and feeds hourly aggregates into the monthly metrics files (metrics.js),
 * so traffic history is browsable per month like CPU/RAM history.
 *
 * This is what "metrics" means for static sites (no pm2 process), and it
 * works for proxied backend domains too.
 */

const WINDOW_MIN = 60;
const READ_CAP = 8 * 1024 * 1024; // max bytes ingested per tick per domain
const MAX_PATHS = 10000;

const state = new Map(); // host -> { offset, minutes: Map, paths: Map, pathsHour }

const minuteOf = (t) => Math.floor(t / 60000) * 60000;
const hourOf = (t) => Math.floor(t / 3600000) * 3600000;

function managedDomains() {
  const domains = new Map(); // host -> { host, https }
  for (const p of store.listProjects()) {
    for (const s of p.services || []) {
      for (const d of s.domains || []) domains.set(d.host, d);
    }
  }
  return domains;
}

/** '$time_iso8601|$host|$status|$body_bytes_sent|$request_time|$request' */
function parseLine(line) {
  const f = line.split('|');
  if (f.length < 6) return null;
  const t = Date.parse(f[0]);
  const status = Number(f[2]);
  if (!t || !status) return null;
  const reqParts = f[5].split(' '); // "GET /path?q HTTP/1.1"
  const path = (reqParts[1] || '/').split('?')[0];
  return { t, status, bytes: Number(f[3]) || 0, path };
}

function addEntry(st, host, e) {
  const mt = minuteOf(e.t);
  const m = st.minutes.get(mt) || { req: 0, bytes: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
  m.req++;
  m.bytes += e.bytes;
  const cls = Math.floor(e.status / 100);
  if (cls === 2) m.s2++;
  else if (cls === 3) m.s3++;
  else if (cls === 4) m.s4++;
  else if (cls >= 5) m.s5++;
  st.minutes.set(mt, m);

  if (st.paths.size < MAX_PATHS || st.paths.has(e.path)) {
    const p = st.paths.get(e.path) || { req: 0, bytes: 0 };
    p.req++;
    p.bytes += e.bytes;
    st.paths.set(e.path, p);
  }

  accumulateDomain(host, e.status, e.bytes); // -> monthly hourly buckets
}

function prune(st) {
  const cutoff = minuteOf(Date.now()) - WINDOW_MIN * 60000;
  for (const t of st.minutes.keys()) if (t < cutoff) st.minutes.delete(t);
  const h = hourOf(Date.now());
  if (st.pathsHour !== h) {
    st.paths = new Map();
    st.pathsHour = h;
  }
}

function ingest(host) {
  const file = logPathFor(host);
  let st = state.get(host);
  if (!st) {
    st = { offset: null, minutes: new Map(), paths: new Map(), pathsHour: hourOf(Date.now()) };
    state.set(host, st);
  }
  let fstat;
  try {
    fstat = fs.statSync(file);
  } catch {
    return; // log not created yet (domain just attached / nginx not reloaded)
  }
  if (st.offset === null) {
    st.offset = fstat.size; // first sight: only collect from now on
    return;
  }
  if (fstat.size < st.offset) st.offset = 0; // logrotate happened
  if (fstat.size === st.offset) {
    prune(st);
    return;
  }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(fstat.size - st.offset, READ_CAP);
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, st.offset);
    st.offset += read;
    const text = buf.toString('utf8', 0, read);
    const nl = text.lastIndexOf('\n');
    if (nl === -1) {
      st.offset -= read; // a single giant partial line — retry next tick
    } else {
      st.offset -= Buffer.byteLength(text.slice(nl + 1)); // keep partial tail
      for (const line of text.slice(0, nl).split('\n')) {
        const e = parseLine(line);
        if (e) addEntry(st, host, e);
      }
    }
  } catch {
    /* unreadable this tick — retry next */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  prune(st);
}

/** Called on an interval from index.js. */
export function collectTick() {
  const domains = managedDomains();
  for (const host of state.keys()) if (!domains.has(host)) state.delete(host);
  for (const host of domains.keys()) ingest(host);
}

/** Live window for a set of hosts: 60 per-minute points + top paths. */
export function getLive(hosts) {
  const start = minuteOf(Date.now()) - (WINDOW_MIN - 1) * 60000;
  const points = [];
  for (let i = 0; i < WINDOW_MIN; i++) {
    const t = start + i * 60000;
    const agg = { t, req: 0, bytes: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
    for (const h of hosts) {
      const m = state.get(h)?.minutes.get(t);
      if (m) {
        agg.req += m.req;
        agg.bytes += m.bytes;
        agg.s2 += m.s2;
        agg.s3 += m.s3;
        agg.s4 += m.s4;
        agg.s5 += m.s5;
      }
    }
    points.push(agg);
  }
  const merged = new Map();
  for (const h of hosts) {
    for (const [p, v] of state.get(h)?.paths || []) {
      const cur = merged.get(p) || { req: 0, bytes: 0 };
      cur.req += v.req;
      cur.bytes += v.bytes;
      merged.set(p, cur);
    }
  }
  const topPaths = [...merged]
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) => b.req - a.req)
    .slice(0, 8);
  return { points, topPaths };
}

/** Check a domain answers locally (through nginx), without leaving the box. */
export function probe({ host, https: isHttps }) {
  return new Promise((resolve) => {
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        host: '127.0.0.1',
        port: isHttps ? 443 : 80,
        path: '/',
        method: 'GET',
        headers: { Host: host },
        servername: host, // SNI so nginx picks the right certificate
        rejectUnauthorized: false,
        timeout: 3500,
      },
      (res) => {
        res.resume();
        resolve({ host, code: res.statusCode });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ host, code: 0, error: e.message }));
    req.end();
  });
}

export function probeAll(domains) {
  return Promise.all((domains || []).map(probe));
}
