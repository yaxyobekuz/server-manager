import { Router } from 'express';
import * as store from '../store.js';
import * as git from '../services/git.js';
import * as nginx from '../services/nginx.js';
import * as metrics from '../services/metrics.js';
import { startDeployment } from '../services/deploy.js';
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
  const service = store.createService(body.projectId, body);
  if (!service) return res.status(404).json({ error: 'Project not found' });
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

router.delete('/:id', (req, res) => {
  const ok = store.deleteService(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Service not found' });
  res.json({ ok: true });
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
  res.json({ history: metrics.getHistory(name), live });
});

/* --------------------------------------------------------------- domains */
// Generate nginx config + (optionally) certbot HTTPS for a service domain.
router.post('/:id/domains', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const { host, port, https, email } = req.body || {};
  if (!host || !port) return res.status(400).json({ error: 'host and port required' });

  try {
    const created = await nginx.createSite({ domain: host, port });
    if (!created.ok) return res.status(400).json(created);

    let httpsResult = null;
    if (https) httpsResult = await nginx.enableHttps({ domain: host, email });

    const domains = [...(service.domains || []).filter((d) => d.host !== host), { host, port, https: Boolean(https) }];
    store.updateService(service.id, { domains });
    res.json({ ok: true, https: httpsResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/domains/:host', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
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
