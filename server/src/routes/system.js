import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import * as metrics from '../services/metrics.js';
import * as pm2 from '../services/pm2.js';
import * as store from '../store.js';
import { run } from '../services/exec.js';
import { config } from '../config.js';

const router = Router();

router.get('/stats', (req, res) => {
  res.json({ system: metrics.systemStats() });
});

/**
 * Everything the server statistics page needs in one call: system stats,
 * every pm2 process, panel counts, which pm2 names belong to panel services
 * (so the UI can link them), the live sample window and available months.
 */
router.get('/overview', async (req, res) => {
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

/** System-wide hourly history for one month. */
router.get('/history', (req, res) => {
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

router.get('/storage', (req, res) => {
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
router.get('/processes', async (req, res) => {
  try {
    res.json({ processes: await pm2.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/processes/:id/:action', async (req, res) => {
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
