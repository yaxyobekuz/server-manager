import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import * as store from '../store.js';
import * as git from '../services/git.js';
import * as nginx from '../services/nginx.js';
import * as metrics from '../services/metrics.js';
import { startDeployment } from '../services/deploy.js';
import { teardownService } from '../services/teardown.js';
import * as pm2 from '../services/pm2.js';

const router = Router();

function parseRepoFullName(repoUrl) {
  if (!repoUrl) return '';
  const m = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

/* ---------------------------------------------------------------- create */
// Services are created under a project: POST /api/projects/:projectId/services
// but we mount this router at /api/services and accept projectId in the body
// for simplicity, plus a nested helper below.

router.post('/', (req, res) => {
  const body = req.body || {};
  if (!body.projectId) return res.status(400).json({ error: 'projectId is required' });
  if (body.repoUrl && !body.repoFullName) body.repoFullName = parseRepoFullName(body.repoUrl);

  const project = store.getProject(body.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // GitHub services deploy to a fixed layout: <projectsRoot>/<project>/<service>.
  // Only 'local' services (existing folders) carry a user-provided path.
  if ((body.sourceType || 'github') === 'github' && !body.localPath) {
    const base = body.name || (body.repoFullName || '').split('/')[1] || 'service';
    body.localPath = path.join(store.projectPath(project), store.slugify(base));
  }

  const service = store.createService(body.projectId, body);
  if (!service) return res.status(404).json({ error: 'Project not found' });
  try {
    if (service.localPath) fs.mkdirSync(service.localPath, { recursive: true });
  } catch {
    /* deploy re-creates it */
  }
  res.status(201).json({ service });
});

router.get('/:id', (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json({ service });
});

router.patch('/:id', (req, res) => {
  const patch = { ...req.body };
  if (patch.repoUrl && !patch.repoFullName) patch.repoFullName = parseRepoFullName(patch.repoUrl);
  const service = store.updateService(req.params.id, patch);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json({ service });
});

// Deleting a service tears down everything it owns: pm2 process, domains
// (nginx config + certificate) and its folder on disk.
router.delete('/:id', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  try {
    const cleanup = await teardownService(service);
    store.deleteService(service.id);
    res.json({ ok: true, cleanup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------- deploy */
router.post('/:id/deploy', (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const deployment = startDeployment(service, {
    trigger: req.body?.trigger || 'manual',
  });
  res.status(202).json({ deployment });
});

router.get('/:id/deployments', (req, res) => {
  res.json({ deployments: store.listDeployments(req.params.id) });
});

router.get('/:id/deployments/:depId', (req, res) => {
  const d = store.getDeployment(req.params.depId);
  if (!d) return res.status(404).json({ error: 'Deployment not found' });
  res.json({ deployment: d });
});

/* ------------------------------------------------------------- variables */
router.get('/:id/variables', (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json({ variables: service.variables || {} });
});

router.put('/:id/variables', (req, res) => {
  const service = store.updateService(req.params.id, { variables: req.body?.variables || {} });
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json({ variables: service.variables });
});

/* ----------------------------------------------------------- git status */
router.get('/:id/git', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  if (!service.localPath) return res.json({ status: null });
  try {
    res.json({ status: await git.status(service.localPath) });
  } catch {
    res.json({ status: null });
  }
});

/* --------------------------------------------------------------- metrics */
router.get('/:id/metrics', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const name = service.pm2Name || service.name;
  let live = null;
  try {
    live = await pm2.describe(name);
  } catch {
    /* process may not be running */
  }
  res.json({
    history: metrics.getHistory(name),
    live,
    months: metrics.listMonths(),
    system: metrics.systemStats(),
    // Disk actually occupied by this service's folder (not the whole server).
    serviceDisk: { path: service.localPath || '', used: await metrics.dirSize(service.localPath) },
  });
});

// Persisted hourly aggregates for one month: ?month=YYYY-MM
router.get('/:id/metrics/history', (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const data = metrics.getMonthHistory(String(req.query.month || ''), service.pm2Name || service.name);
  if (!data) return res.status(400).json({ error: 'month must be YYYY-MM' });
  res.json(data);
});

/* --------------------------------------------------------------- domains */
// Generate nginx config + (optionally) certbot HTTPS for a service domain.
// Backend services get a reverse proxy to their port; static services get
// an nginx root pointing at the build output — no port, no pm2.
router.post('/:id/domains', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const { host, https, email } = req.body || {};
  if (!host) return res.status(400).json({ error: 'host required' });

  let siteOpts;
  let entry;

  if ((service.serviceKind || 'auto') === 'static') {
    const workdir = service.rootDirectory
      ? path.join(service.localPath || '', service.rootDirectory)
      : service.localPath || '';
    const outputDir = String(req.body.outputDir ?? service.staticOutputDir ?? '').trim();
    const rootPath = path.resolve(workdir || '/', outputDir);
    if (!fs.existsSync(path.join(rootPath, 'index.html'))) {
      return res.status(400).json({ error: `No build output at ${rootPath} — deploy the service first (or fix the build path).` });
    }
    if (outputDir !== (service.staticOutputDir || '')) {
      store.updateService(service.id, { staticOutputDir: outputDir });
    }
    siteOpts = { domain: host, rootPath };
    entry = { host, https: Boolean(https), root: rootPath };
  } else {
    const port = Number(req.body.port || service.port);
    if (!port) return res.status(400).json({ error: 'port required (set it in Settings or pass it here)' });
    siteOpts = { domain: host, port };
    entry = { host, https: Boolean(https), port };
  }

  try {
    const created = await nginx.createSite(siteOpts);
    if (!created.ok) return res.status(400).json(created);

    let httpsResult = null;
    if (https) httpsResult = await nginx.enableHttps({ domain: host, email });

    const domains = [...(service.domains || []).filter((d) => d.host !== host), entry];
    store.updateService(service.id, { domains });
    res.json({ ok: true, https: httpsResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/domains/:host', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const entry = (service.domains || []).find((d) => d.host === req.params.host);
  if (entry?.https) await nginx.deleteHttps(entry.host); // drop the certificate too
  try {
    await nginx.deleteSite(req.params.host);
  } catch {
    /* ignore */
  }
  const domains = (service.domains || []).filter((d) => d.host !== req.params.host);
  store.updateService(service.id, { domains });
  res.json({ ok: true });
});

export default router;
