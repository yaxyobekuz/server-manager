import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import * as metrics from '../services/metrics.js';
import * as pm2 from '../services/pm2.js';
import * as store from '../store.js';
import * as traffic from '../services/traffic.js';
import * as domainScan from '../services/domainScan.js';
import * as nginxSvc from '../services/nginx.js';
import * as sysinfo from '../services/sysinfo.js';
import { run } from '../services/exec.js';
import { requirePerm } from '../auth.js';
import { config } from '../config.js';

const router = Router();

router.get('/stats', requirePerm('metrics'), (req, res) => {
  res.json({ system: metrics.systemStats() });
});

// Everything the Information page shows about the machine, plus panel counts.
router.get('/info', requirePerm('serverInfo'), async (req, res) => {
  try {
    const info = await sysinfo.getInfo();
    let procs = { total: 0, online: 0 };
    try {
      const list = await pm2.list();
      procs = { total: list.length, online: list.filter((p) => p.status === 'online').length };
    } catch {
      /* pm2 down — the page still renders */
    }
    const projects = store.listProjects();
    res.json({
      ...info,
      panel: {
        projects: projects.length,
        services: projects.reduce((n, p) => n + (p.services?.length || 0), 0),
        pm2: procs,
        port: config.port,
        projectsRoot: config.projectsRoot,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One speed-test phase (ping | download | upload) — the client runs them in
// sequence so it can show per-phase progress. POST: it consumes real bandwidth.
router.post('/speedtest/:phase', requirePerm('serverInfo'), async (req, res) => {
  try {
    res.json(await sysinfo.speedtest(req.params.phase));
  } catch (err) {
    res.status(err.busy ? 429 : 500).json({ error: err.message });
  }
});

// Every domain the machine actually serves: nginx vhosts (panel-managed or
// not) + Let's Encrypt certs, merged with panel attachments. Read-only scan.
router.get('/domains', requirePerm('domainsGlobal'), (req, res) => {
  try {
    res.json(domainScan.scanDomains(req.query.refresh === '1'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full teardown of a scanned domain — removes exactly what the admin ticked:
// ?nginx=1 deletes the vhost (config + enabled symlink, nginx reloaded),
// ?cert=1 deletes the Let's Encrypt certificate. When the vhost goes away the
// host is also detached from whichever panel service held it.
router.delete('/domains/:host', requirePerm('domainsGlobal'), async (req, res) => {
  const host = req.params.host;
  const delNginx = req.query.nginx === '1';
  const delCert = req.query.cert === '1';
  if (!delNginx && !delCert) return res.status(400).json({ error: 'Nothing selected to delete' });
  const found = domainScan.findHost(host, true);
  if (!found) return res.status(404).json({ error: 'Domain not found in the scan' });

  const steps = [];
  if (delNginx) {
    if (found.file) {
      try {
        await nginxSvc.deleteSite(found.file);
        steps.push({ step: `nginx config (${found.file})`, ok: true, output: '' });
      } catch (e) {
        steps.push({ step: `nginx config (${found.file})`, ok: false, output: e.message });
      }
    } else {
      steps.push({ step: 'nginx config', ok: true, output: 'none existed' });
    }
  }
  if (delCert && found.cert) {
    // A shared certificate (SANs covering other hosts) is a foot-gun: deleting
    // it leaves the other hosts' configs pointing at a missing file and
    // nginx -t fails server-wide. Require explicit confirmation.
    const scanAll = domainScan.scanDomains();
    const others = found.cert.hosts.filter(
      (h) => h !== host && scanAll.domains.some((d) => d.host === h && d.file && !(delNginx && d.file === found.file))
    );
    if (others.length && req.query.force !== '1') {
      return res.status(400).json({
        error: `Certificate ${found.cert.name} also covers ${others.join(', ')} — deleting it breaks their HTTPS and can make nginx fail to reload. Confirm the shared-certificate warning to proceed.`,
        sharedWith: others,
      });
    }
  }
  if (delCert) {
    if (found.cert) {
      const r = await nginxSvc.deleteHttps(found.cert.name);
      steps.push({
        step: `certificate (${found.cert.name})`,
        ok: r.ok,
        output: r.ok ? '' : r.output.trim().split('\n').slice(-4).join('\n'),
      });
    } else {
      steps.push({ step: 'certificate', ok: true, output: 'none existed' });
    }
  }
  if (delNginx) {
    // the host is no longer served — drop it from whichever service holds it
    for (const p of store.listProjects()) {
      for (const s of p.services || []) {
        if ((s.domains || []).some((d) => d.host === host)) {
          store.updateService(s.id, { domains: s.domains.filter((d) => d.host !== host) });
          steps.push({ step: `detached from ${p.name} / ${s.name}`, ok: true, output: '' });
        }
      }
    }
  }
  domainScan.scanDomains(true); // the next page load shows reality
  res.json({ ok: steps.every((s) => s.ok), steps });
});

/**
 * Everything the server statistics page needs in one call: system stats,
 * every pm2 process, panel counts, which pm2 names belong to panel services
 * (so the UI can link them), the live sample window and available months.
 */
router.get('/overview', requirePerm('statistics'), async (req, res) => {
  let procs = [];
  try {
    procs = await pm2.list();
  } catch {
    /* pm2 down — page still renders system stats */
  }
  const summary = {
    total: procs.length,
    online: procs.filter((p) => p.status === 'online').length,
    errored: procs.filter((p) => p.status === 'errored').length,
    stopped: procs.filter((p) => p.status === 'stopped').length,
    memory: procs.reduce((s, p) => s + (p.memory || 0), 0),
    cpu: +procs.reduce((s, p) => s + (p.cpu || 0), 0).toFixed(1),
  };

  const projects = store.listProjects();
  const managed = {}; // pm2Name -> where it lives in the panel
  for (const p of projects) {
    for (const s of p.services || []) {
      managed[s.pm2Name || s.name] = { projectId: p.id, serviceId: s.id, kind: s.serviceKind };
    }
  }

  res.json({
    system: {
      ...metrics.systemStats(),
      cpuModel: os.cpus()[0]?.model || '',
      nodeVersion: process.version,
    },
    processes: procs,
    summary,
    counts: {
      projects: projects.length,
      services: projects.reduce((n, p) => n + (p.services?.length || 0), 0),
    },
    managed,
    window: metrics.getSystemWindow(),
    months: metrics.listMonths(),
  });
});

/**
 * Comparative usage per project — "which project eats the most".
 * Live (no ?month): current pm2 CPU/RAM sums + last-60-min domain traffic.
 * ?month=YYYY-MM: hourly per-hour sums across the project's processes
 * (avg + peak) and the month's domain traffic totals.
 * Disk is always the current du of the project's service folders.
 */
router.get('/projects', requirePerm('statistics'), async (req, res) => {
  const month = String(req.query.month || '');
  const isMonth = /^\d{4}-\d{2}$/.test(month);
  const projects = store.listProjects();

  let pm2ByName = new Map();
  if (!isMonth) {
    try {
      pm2ByName = new Map((await pm2.list()).map((p) => [p.name, p]));
    } catch {
      /* pm2 down — CPU/RAM just read 0 */
    }
  }
  const monthData = isMonth ? metrics.getMonthAll(month) : null;

  const rows = await Promise.all(
    projects.map(async (p) => {
      const services = p.services || [];
      const names = services.map((s) => s.pm2Name || s.name);
      const hosts = services.flatMap((s) => (s.domains || []).map((d) => d.host));

      let cpu = 0, cpuMax = 0, mem = 0, memMax = 0, online = 0;
      if (isMonth) {
        // Sum the project's processes per hour, then average/peak over hours —
        // summing each service's own avg/max would overstate the peak.
        const byHour = new Map();
        for (const n of names) {
          for (const pt of monthData.procs[n] || []) {
            const a = byHour.get(pt.t) || { cpu: 0, mem: 0 };
            a.cpu += pt.cpu || 0;
            a.mem += pt.mem || 0;
            byHour.set(pt.t, a);
          }
        }
        const sums = [...byHour.values()];
        if (sums.length) {
          cpu = sums.reduce((a, x) => a + x.cpu, 0) / sums.length;
          mem = sums.reduce((a, x) => a + x.mem, 0) / sums.length;
          cpuMax = Math.max(...sums.map((x) => x.cpu));
          memMax = Math.max(...sums.map((x) => x.mem));
        }
      } else {
        for (const n of names) {
          const proc = pm2ByName.get(n);
          if (!proc) continue;
          cpu += proc.cpu || 0;
          mem += proc.memory || 0;
          if (proc.status === 'online') online++;
        }
        cpuMax = cpu;
        memMax = mem;
      }

      let reqs = 0, bytes = 0;
      if (isMonth) {
        for (const h of hosts) {
          for (const pt of monthData.domains[h] || []) {
            reqs += pt.req || 0;
            bytes += pt.bytes || 0;
          }
        }
      } else if (hosts.length) {
        for (const pt of traffic.getLive(hosts).points) {
          reqs += pt.req || 0;
          bytes += pt.bytes || 0;
        }
      }

      const disks = await Promise.all(services.map((s) => metrics.dirSize(s.localPath)));

      return {
        id: p.id,
        name: p.name,
        services: services.length,
        domains: hosts.length,
        online,
        cpu: +cpu.toFixed(1),
        cpuMax: +cpuMax.toFixed(1),
        mem: Math.round(mem),
        memMax: Math.round(memMax),
        disk: disks.reduce((a, b) => a + b, 0),
        req: reqs,
        bytes,
      };
    })
  );

  rows.sort((a, b) => b.mem - a.mem);
  res.json({ period: isMonth ? month : 'live', projects: rows });
});

/** System-wide hourly history for one month. */
router.get('/history', requirePerm('statistics'), (req, res) => {
  const month = String(req.query.month || '');
  const system = metrics.getMonthSystem(month);
  if (system === null) return res.status(400).json({ error: 'month=YYYY-MM required' });
  res.json({ month, system });
});

/* ------------------------------------------------------------- storage scan
 * Sizes of every top-level folder under projectsRoot (du over ~all projects
 * takes ~15-20s cold), so: scan in the background, cache for 10 minutes, and
 * answer immediately with whatever we have. First-ever call returns
 * { pending: true } and the client polls.
 */
let storageCache = null; // { scannedAt, root, folders: [{name,path,bytes,managed}] }
let storageScan = null;
const STORAGE_TTL = 10 * 60 * 1000;

async function scanStorage() {
  const root = config.projectsRoot;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => path.join(root, d.name));
  const sizes = new Map();
  if (dirs.length) {
    const res = await run('du', ['-sk', '--', ...dirs], { timeout: 180000 });
    for (const line of (res.stdout || '').split('\n')) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) sizes.set(m[2], Number(m[1]) * 1024);
    }
  }
  const projectPaths = new Set(store.listProjects().map((p) => store.projectPath(p)));
  const folders = dirs
    .map((p) => ({ name: path.basename(p), path: p, bytes: sizes.get(p) || 0, managed: projectPaths.has(p) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { scannedAt: Date.now(), root, folders };
}

router.get('/storage', requirePerm('statistics'), (req, res) => {
  const fresh = storageCache && Date.now() - storageCache.scannedAt < STORAGE_TTL;
  if (!fresh && !storageScan) {
    storageScan = scanStorage()
      .then((r) => {
        storageCache = r;
      })
      .catch(() => {
        /* keep the previous cache on failure */
      })
      .finally(() => {
        storageScan = null;
      });
  }
  if (storageCache) return res.json({ ...storageCache, refreshing: !fresh });
  res.json({ pending: true });
});

// All pm2 processes on the box (used by the global "Processes" view).
router.get('/processes', requirePerm('processes'), async (req, res) => {
  try {
    res.json({ processes: await pm2.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/processes/:id/:action', requirePerm('processControl'), async (req, res) => {
  const { id, action } = req.params;
  try {
    if (action === 'restart') await pm2.restart(id);
    else if (action === 'stop') await pm2.stop(id);
    else if (action === 'start') await pm2.start(id);
    else return res.status(400).json({ error: 'Unknown action' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
