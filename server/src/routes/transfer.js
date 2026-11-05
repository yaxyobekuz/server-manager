import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import * as store from '../store.js';
import { Remote, normalizeUrl } from '../services/remote.js';
import * as bundle from '../services/bundle.js';
import * as apply from '../services/apply.js';
import * as transfer from '../services/transfer.js';

/**
 * Moving projects between two servers that both run this panel.
 *
 * The routes come in two flavours:
 *  - machine-to-machine (hello / catalog / plan / preflight / bundle /
 *    apply / quiesce / resume / release): called BY the other panel, which
 *    authenticated with this server's admin password, exactly as a human
 *    would. They are the whole API surface of a transfer.
 *  - panel UI (servers CRUD, inspect, start, jobs): called by the browser.
 *
 * Everything here is owner-only: a transfer carries source code, .env files
 * and database dumps, so it is not something a scoped admin may trigger.
 */

const router = Router();
const workRoot = () => path.join(config.dataDir, 'transfers');
const fail = (res, err) => res.status(400).json({ error: err?.message || String(err) });

/* =============================================== called by the other panel */

/** Identity + capabilities. Also what "Check" on the Servers page uses. */
router.get('/hello', (req, res) => {
  res.json({ server: bundle.localInfo() });
});

/** Projects this server could hand over, with enough detail to choose one. */
router.get('/catalog', (req, res) => {
  const projects = store.listProjects().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || '',
    createdAt: p.createdAt,
    services: (p.services || []).map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.serviceKind || 'auto',
      sourceType: s.sourceType,
      repoFullName: s.repoFullName || '',
      port: s.port || '',
      domains: (s.domains || []).map((d) => d.host),
    })),
    domains: (p.services || []).flatMap((s) => (s.domains || []).map((d) => d.host)),
  }));
  res.json({ server: bundle.localInfo(), projects });
});

/** Exactly what would move, with sizes — no credentials. */
router.post('/plan/:projectId', async (req, res) => {
  try {
    res.json({ plan: await bundle.buildPlan(req.params.projectId, req.body?.options) });
  } catch (err) {
    fail(res, err);
  }
});

/** Could THIS server take that plan? */
router.post('/preflight', async (req, res) => {
  try {
    if (!req.body?.plan) return res.status(400).json({ error: 'plan is required' });
    res.json({ preflight: await apply.preflight(req.body.plan, req.body.options) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Build a bundle and stream it back. It is staged to disk first so the
 * response can carry a Content-Length — that is what gives the other side a
 * real progress bar instead of a spinner.
 */
router.post('/bundle/:projectId', async (req, res) => {
  const options = bundle.normalizeOptions(req.body?.options);
  const dir = path.join(workRoot(), `out-${crypto.randomUUID()}`);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const project = store.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    fs.mkdirSync(path.join(dir, 'stage'), { recursive: true });
    await bundle.buildBundle({ projectId: project.id, options, dir: path.join(dir, 'stage') });
    const file = path.join(dir, 'bundle.tar');
    const bytes = await bundle.packBundle(path.join(dir, 'stage'), file);

    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(bytes));
    res.setHeader('x-sm-project', encodeURIComponent(project.name));
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', cleanup);
    stream.pipe(res);
  } catch (err) {
    cleanup();
    if (!res.headersSent) fail(res, err);
  }
});

/**
 * Receive a pushed bundle and import it here. Answers as soon as the upload
 * has landed with the id of the import job, which the pusher then follows
 * through /jobs/:id so its operator sees every step of this side too.
 */
router.post('/apply', (req, res) => {
  let options = {};
  try {
    options = JSON.parse(Buffer.from(String(req.query.options || ''), 'base64url').toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'options query is not valid base64url JSON' });
  }

  fs.mkdirSync(workRoot(), { recursive: true });
  const file = path.join(workRoot(), `in-${crypto.randomUUID()}.tar`);
  const out = fs.createWriteStream(file);
  const expected = Number(req.headers['content-length'] || 0);
  let written = 0;
  let aborted = false;

  const abort = (message) => {
    if (aborted) return;
    aborted = true;
    out.destroy();
    fs.rmSync(file, { force: true });
    if (!res.headersSent) res.status(400).json({ error: message });
  };

  req.on('data', (c) => {
    written += c.length;
  });
  req.on('aborted', () => abort('the upload was interrupted'));
  out.on('error', (e) => abort(`could not store the upload: ${e.message}`));
  out.on('finish', () => {
    if (aborted) return;
    if (expected && written !== expected) {
      return abort(`the upload is incomplete (${written} of ${expected} bytes)`);
    }
    const job = transfer.startApplyJob({
      file,
      options,
      from: String(req.headers['x-sm-from'] || '').slice(0, 80) || 'another server',
    });
    res.json({ jobId: job.id });
  });

  req.pipe(out);
});

router.post('/quiesce/:projectId', async (req, res) => {
  try {
    res.json(await apply.quiesceProject(req.params.projectId));
  } catch (err) {
    fail(res, err);
  }
});

router.post('/resume/:projectId', async (req, res) => {
  try {
    res.json(await apply.resumeProject(req.params.projectId));
  } catch (err) {
    fail(res, err);
  }
});

router.post('/release/:projectId', async (req, res) => {
  try {
    res.json(await apply.releaseProject(req.params.projectId, req.body?.options));
  } catch (err) {
    fail(res, err);
  }
});

/* ============================================================== linked servers */

router.get('/servers', (req, res) => {
  res.json({ servers: store.listServers(), here: bundle.localInfo() });
});

/** Verify a server answers and speaks the same protocol before saving it. */
async function verify({ url, password, insecure, name }) {
  const remote = new Remote({ url, password, insecure, name });
  await remote.login();
  const { server } = await remote.hello();
  if (Number(server?.protocol) !== bundle.PROTOCOL) {
    throw new Error(
      `${remote.base} runs transfer protocol v${server?.protocol ?? '?'}, this panel v${bundle.PROTOCOL} — update the older side first`
    );
  }
  return server;
}

router.post('/servers', async (req, res) => {
  const { name, password, insecure } = req.body || {};
  try {
    const url = normalizeUrl(req.body?.url);
    if (!password) return res.status(400).json({ error: 'The other server\'s admin password is required' });
    if (store.listServers().some((s) => s.url === url)) {
      return res.status(400).json({ error: `${url} is already linked` });
    }
    const info = await verify({ url, password, insecure, name });
    if (info.hostname === bundle.localInfo().hostname && info.projectsRoot === config.projectsRoot) {
      return res.status(400).json({ error: 'That URL points back at THIS server — link the other machine instead.' });
    }
    const server = store.createServer({ name: name || info.hostname || url, url, password, insecure });
    store.updateServer(server.id, { info, lastSeenAt: new Date().toISOString(), lastError: '' });
    res.status(201).json({ server: store.getServer(server.id) });
  } catch (err) {
    fail(res, err);
  }
});

router.patch('/servers/:id', async (req, res) => {
  const current = store.getServerSecret(req.params.id);
  if (!current) return res.status(404).json({ error: 'Server not found' });
  try {
    const url = req.body?.url ? normalizeUrl(req.body.url) : current.url;
    const password = req.body?.password || current.password;
    const insecure = 'insecure' in (req.body || {}) ? Boolean(req.body.insecure) : current.insecure;
    const name = req.body?.name ?? current.name;
    const changed = url !== current.url || Boolean(req.body?.password) || insecure !== current.insecure;
    let info = current.info;
    if (changed) {
      if (!password) return res.status(400).json({ error: 'The other server\'s admin password is required' });
      info = await verify({ url, password, insecure, name });
    }
    store.updateServer(current.id, {
      name,
      url,
      insecure,
      info,
      ...(req.body?.password ? { password: req.body.password } : {}),
      ...(changed ? { lastSeenAt: new Date().toISOString(), lastError: '' } : {}),
    });
    res.json({ server: store.getServer(current.id) });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/servers/:id', (req, res) => {
  res.json({ ok: store.deleteServer(req.params.id) });
});

/** Re-check a saved server (also refreshes its hostname / tool list). */
router.post('/servers/:id/check', async (req, res) => {
  const row = store.getServerSecret(req.params.id);
  if (!row) return res.status(404).json({ error: 'Server not found' });
  if (!row.password) {
    const error = 'the saved password can no longer be decrypted (JWT_SECRET changed) — enter it again';
    store.updateServer(row.id, { lastError: error });
    return res.status(400).json({ error });
  }
  try {
    const info = await verify(row);
    store.updateServer(row.id, { info, lastSeenAt: new Date().toISOString(), lastError: '' });
    res.json({ server: store.getServer(row.id) });
  } catch (err) {
    store.updateServer(row.id, { lastError: err.message });
    res.status(400).json({ error: err.message, server: store.getServer(row.id) });
  }
});

/** The other server's projects — the import picker. */
router.get('/servers/:id/catalog', async (req, res) => {
  const row = store.getServerSecret(req.params.id);
  if (!row) return res.status(404).json({ error: 'Server not found' });
  try {
    const remote = new Remote(row);
    const data = await remote.catalog();
    store.updateServer(row.id, { info: data.server, lastSeenAt: new Date().toISOString(), lastError: '' });
    res.json(data);
  } catch (err) {
    store.updateServer(row.id, { lastError: err.message });
    fail(res, err);
  }
});

/* ==================================================================== moves */

/**
 * Dry run: what would move, and would the destination accept it. Both halves
 * in one call so the modal can show one readable summary.
 */
router.post('/inspect', async (req, res) => {
  const { direction, serverId, projectId, options } = req.body || {};
  try {
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    const row = store.getServerSecret(serverId);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    const remote = new Remote(row);
    let plan;
    let preflight;
    if (direction === 'push') {
      plan = await bundle.buildPlan(projectId, options);
      preflight = (await remote.preflight(plan, options)).preflight;
    } else {
      plan = (await remote.plan(projectId, options)).plan;
      preflight = await apply.preflight(plan, options);
    }
    res.json({ plan, preflight });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/start', (req, res) => {
  const { direction, serverId, projectId, options, projectName } = req.body || {};
  try {
    if (!['push', 'pull'].includes(direction)) return res.status(400).json({ error: 'direction must be push or pull' });
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    if (direction === 'push' && !store.getProject(projectId)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const running = transfer
      .listJobs()
      .find((j) => j.status === 'running' && ['push', 'pull'].includes(j.direction));
    if (running) {
      return res.status(409).json({ error: `A transfer is already running (${running.projectName || 'project'}) — wait for it to finish.` });
    }
    const job = transfer.startTransfer({ direction, serverId, projectId, options, projectName });
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/jobs', (req, res) => {
  res.json({ jobs: transfer.listJobs() });
});

router.get('/jobs/:id', (req, res) => {
  const job = transfer.jobView(req.params.id, Number(req.query.since) || 0);
  if (!job) return res.status(404).json({ error: 'Transfer not found' });
  res.json({ job });
});

/** Finish a move whose source was deliberately left in place. */
router.post('/jobs/:id/release', async (req, res) => {
  try {
    res.json(await transfer.releaseSourceNow(req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/jobs/:id', (req, res) => {
  const ok = transfer.forgetJob(req.params.id);
  if (!ok) return res.status(400).json({ error: 'That transfer is still running' });
  res.json({ ok });
});

export default router;
