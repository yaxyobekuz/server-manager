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
import * as traffic from '../services/traffic.js';

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
  // projectName rides along for the breadcrumb — saves the client a request.
  res.json({ service, projectName: store.getProject(service.projectId)?.name || '' });
});

router.patch('/:id', (req, res) => {
  const before = store.getService(req.params.id);
  if (!before) return res.status(404).json({ error: 'Service not found' });
  const patch = { ...req.body };
  // variables and domains have their own endpoints — a Settings save built
  // from a stale full-service snapshot must never clobber what was saved in
  // another tab meanwhile (save Variables → save Settings → old vars back).
  delete patch.variables;
  delete patch.domains;
  if (patch.repoUrl && !patch.repoFullName) patch.repoFullName = parseRepoFullName(patch.repoUrl);
  const service = store.updateService(req.params.id, patch);
  // A rename re-derives the pm2 name; the old-named process would linger (and
  // keep the port) forever, so drop it — the next deploy starts the new name.
  if (before.pm2Name && service.pm2Name !== before.pm2Name) {
    pm2.deleteProc(before.pm2Name).catch(() => {});
  }
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

/* --------------------------------------------------------------- traffic */
// HTTP traffic through the service's domains (nginx access logs): live
// per-minute window, top paths this hour, and a health probe per domain.
// This is the metrics source for static sites — works for backends too.
router.get('/:id/traffic', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const hosts = (service.domains || []).map((d) => d.host);
  res.json({
    hosts,
    ...traffic.getLive(hosts),
    probes: await traffic.probeAll(service.domains),
    months: metrics.listMonths(),
    serviceDisk: { path: service.localPath || '', used: await metrics.dirSize(service.localPath) },
  });
});

// Persisted hourly traffic for one month, summed across the service's domains.
router.get('/:id/traffic/history', (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const hosts = (service.domains || []).map((d) => d.host);
  const points = metrics.getMonthDomains(String(req.query.month || ''), hosts);
  if (points === null) return res.status(400).json({ error: 'month must be YYYY-MM' });
  res.json({ points });
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

    // entry.https stays the *wish* even when certbot fails — the status
    // endpoint reports reality and Repair enforces the wish later.
    let httpsResult = null;
    if (https) httpsResult = await nginx.enableHttps({ domain: host, email });

    const domains = [...(service.domains || []).filter((d) => d.host !== host), entry];
    store.updateService(service.id, { domains });
    res.json({ ok: true, https: httpsResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What nginx actually has per attached domain — lets the UI flag a domain
// whose HTTPS silently failed (entry says https, config has no 443 block).
router.get('/:id/domains/status', (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json({
    statuses: (service.domains || []).map((d) => ({
      host: d.host,
      https: Boolean(d.https),
      ...nginx.siteStatus(d.host),
    })),
  });
});

// One-click repair: rewrite the nginx config from the stored entry, put SSL
// back (reusing the existing certificate when there is one), reload and
// probe. Covers "folder deleted and redeployed", lost 443 blocks and missing
// symlinks without detaching the domain.
router.post('/:id/domains/:host/repair', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const entry = (service.domains || []).find((d) => d.host === req.params.host);
  if (!entry) return res.status(404).json({ error: 'Domain not found' });

  let siteOpts;
  if (entry.root) {
    if (!fs.existsSync(path.join(entry.root, 'index.html'))) {
      return res.status(400).json({ error: `No build output at ${entry.root} — deploy the service first.` });
    }
    siteOpts = { domain: entry.host, rootPath: entry.root };
  } else {
    const port = Number(entry.port || service.port);
    if (!port) return res.status(400).json({ error: 'No port on this domain or service — set it in Settings.' });
    siteOpts = { domain: entry.host, port };
  }

  const steps = [];
  const created = await nginx.createSite(siteOpts);
  steps.push({ step: 'nginx config', ok: created.ok, output: created.ok ? '' : `${created.step}: ${created.output}` });
  if (!created.ok) return res.json({ ok: false, steps });

  if (entry.https) {
    const httpsResult = await nginx.enableHttps({ domain: entry.host, email: req.body?.email });
    steps.push({
      step: httpsResult.reusedCert ? 'https (existing certificate)' : 'https (certbot)',
      ok: httpsResult.ok,
      output: httpsResult.ok ? '' : httpsResult.output.trim().split('\n').slice(-6).join('\n'),
    });
  }

  const probe = await traffic.probe(entry);
  const probeOk = probe.code >= 200 && probe.code < 500; // 4xx = app answered
  steps.push({ step: 'probe', ok: probeOk, output: probe.code ? `HTTP ${probe.code}` : probe.error || 'no response' });

  res.json({ ok: steps.every((s) => s.ok), steps });
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
