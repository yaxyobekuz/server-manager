import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import * as store from '../store.js';
import * as git from '../services/git.js';
import * as nginx from '../services/nginx.js';
import * as metrics from '../services/metrics.js';
import { startDeployment } from '../services/deploy.js';
import * as envFile from '../services/env.js';
import { teardownService } from '../services/teardown.js';
import * as pm2 from '../services/pm2.js';
import * as traffic from '../services/traffic.js';
import * as domainScan from '../services/domainScan.js';
import { can, canProject, requirePerm } from '../auth.js';

const router = Router();

// Every /:id route is scoped through the service's project — an admin only
// reaches services inside projects on their list.
router.param('id', (req, res, next, serviceId) => {
  const service = store.getService(serviceId);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  if (!canProject(req.auth, service.projectId)) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  next();
});

function parseRepoFullName(repoUrl) {
  if (!repoUrl) return '';
  const m = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

// Users paste full URLs ("https://api.example.com/") into the domain field —
// only the bare hostname must ever reach the db, nginx or certbot.
function normalizeHost(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z+.-]+:\/\//, '') // scheme
    .split(/[/?#]/)[0] // path / query / fragment
    .replace(/:\d+$/, '') // port
    .replace(/^\.+|\.+$/g, ''); // stray dots
}
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function badHost(raw, host) {
  if (!host) return 'host required';
  if (!HOST_RE.test(host)) {
    return `"${raw}" is not a valid domain name — enter just the hostname, e.g. api.example.com`;
  }
  return null;
}

/* ---------------------------------------------------------------- create */
// Services are created under a project: POST /api/projects/:projectId/services
// but we mount this router at /api/services and accept projectId in the body
// for simplicity, plus a nested helper below.

router.post('/', requirePerm('editServices'), (req, res) => {
  const body = req.body || {};
  if (!body.projectId) return res.status(400).json({ error: 'projectId is required' });
  if (!canProject(req.auth, body.projectId)) {
    return res.status(403).json({ error: 'No access to this project' });
  }
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

router.get('/:id', async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  // Live pm2 state rides along so the header can offer Stop/Start and flag a
  // service whose last deploy succeeded but whose process is down now.
  let pm2Status = null;
  if ((service.serviceKind || 'auto') !== 'static') {
    const proc = await pm2.describe(service.pm2Name || service.name).catch(() => null);
    pm2Status = proc?.status || null; // null = never deployed / no process
  }
  // projectName rides along for the breadcrumb — saves the client a request.
  res.json({ service, projectName: store.getProject(service.projectId)?.name || '', pm2Status });
});

router.patch('/:id', requirePerm('editServices'), (req, res) => {
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

// Admin-editable creation date; every change lands in createdAtHistory.
router.put('/:id/created-at', requirePerm('editServices'), (req, res) => {
  const { createdAt, note } = req.body || {};
  const service = store.setServiceCreatedAt(req.params.id, createdAt, note);
  if (!service) return res.status(400).json({ error: 'Service not found or createdAt is not a valid date' });
  res.json({ service });
});

// Deleting a service tears down everything it owns: pm2 process, domains
// (nginx config + certificate) and its folder on disk.
router.delete('/:id', requirePerm('deleteServices'), async (req, res) => {
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
router.post('/:id/deploy', requirePerm('deploy'), (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const deployment = startDeployment(service, {
    trigger: req.body?.trigger || 'manual',
  });
  res.status(202).json({ deployment });
});

/* ------------------------------------------------------------ stop/start */
// Stop or start this service's pm2 process (same rules as the project-level
// buttons: static sites have no process, a never-deployed service has
// nothing to stop, and the state is saved so it survives server reboots).
async function servicePm2(req, res, verb) {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  if ((service.serviceKind || 'auto') === 'static') {
    return res.status(400).json({ error: 'Static services have no process — nginx serves them directly.' });
  }
  const name = service.pm2Name || service.name;
  if (!(await pm2.describe(name).catch(() => null))) {
    return res.status(400).json({ error: `No pm2 process "${name}" yet — deploy the service first.` });
  }
  try {
    await (verb === 'stop' ? pm2.stop(name) : pm2.start(name));
    await pm2.save().catch(() => {});
    const proc = await pm2.describe(name).catch(() => null);
    res.json({ ok: true, pm2Status: proc?.status || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

router.post('/:id/stop', requirePerm('deploy'), (req, res) => servicePm2(req, res, 'stop'));
router.post('/:id/start', requirePerm('deploy'), (req, res) => servicePm2(req, res, 'start'));

router.get('/:id/deployments', (req, res) => {
  res.json({ deployments: store.listDeployments(req.params.id) });
});

router.get('/:id/deployments/:depId', (req, res) => {
  const d = store.getDeployment(req.params.depId);
  if (!d) return res.status(404).json({ error: 'Deployment not found' });
  res.json({ deployment: d });
});

/* ------------------------------------------------------------- variables */
// The service's .env FILE is the source of truth: reads parse it, saves
// patch it in place (comments/order survive). The db copy is only a staging
// area that seeds .env on the first deploy of a fresh clone.
router.get('/:id/variables', requirePerm('variables'), (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json(envFile.readServiceVariables(service));
});

router.put('/:id/variables', requirePerm('variables'), (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const variables = req.body?.variables || {};
  const written = envFile.writeServiceVariables(service, variables);
  store.updateService(service.id, { variables }); // bootstrap copy for fresh clones
  res.json({ variables, source: written.ok ? 'file' : 'panel', path: written.path });
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
router.get('/:id/metrics', requirePerm('metrics'), async (req, res) => {
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
router.get('/:id/metrics/history', requirePerm('metrics'), (req, res) => {
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
router.get('/:id/traffic', requirePerm('metrics'), async (req, res) => {
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
router.get('/:id/traffic/history', requirePerm('metrics'), (req, res) => {
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
router.post('/:id/domains', requirePerm('domainsService'), async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const { https, email } = req.body || {};
  const host = normalizeHost(req.body?.host);
  const invalid = badHost(req.body?.host, host);
  if (invalid) return res.status(400).json({ error: invalid });

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
    if (!created.ok) {
      // Surface WHY (nginx -t / reload output) — a bare {step, output} body
      // renders as a useless "Request failed (400)" in the client.
      const tail = String(created.output || '').trim().split('\n').slice(-3).join(' · ');
      return res.status(400).json({ ...created, error: `nginx ${created.step} failed: ${tail || 'unknown error'}` });
    }

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
// The scan adds what siteStatus can't see: certificate expiry, and whether
// the config was written by the panel or by hand (external).
router.get('/:id/domains/status', requirePerm('domainsService'), (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const byHost = new Map(domainScan.scanDomains().domains.map((d) => [d.host, d]));
  res.json({
    statuses: (service.domains || []).map((d) => {
      const scan = byHost.get(d.host);
      // The scan finds hosts served from a conf file with a different name
      // (aliases, hand-written files) that siteStatus would miss.
      const real = scan?.file
        ? { confExists: true, enabled: scan.enabled, ssl: scan.ssl }
        : nginx.siteStatus(d.host);
      return {
        host: d.host,
        https: Boolean(d.https),
        ...real,
        managed: scan?.file ? scan.managed : true,
        certDaysLeft: scan?.cert?.daysLeft ?? null,
      };
    }),
  });
});

// Attach an EXISTING domain (found by the nginx/certbot scan) to this
// service — db-only: the working config and certificate are left exactly as
// they are. This is how pre-existing sites get linked to registered services.
router.post('/:id/domains/adopt', requirePerm('domainsService'), (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const host = normalizeHost(req.body?.host);
  const invalid = badHost(req.body?.host, host);
  if (invalid) return res.status(400).json({ error: invalid });

  const found = domainScan.findHost(host, true);
  if (!found || !found.file) {
    return res.status(400).json({ error: `No nginx config found for ${host} — use "Add a domain" to create one.` });
  }
  if (found.service && found.service.id !== service.id) {
    return res.status(400).json({ error: `${host} is already attached to ${found.service.projectName} / ${found.service.name}.` });
  }
  const entry = {
    host,
    https: Boolean(found.ssl),
    ...(found.root ? { root: found.root } : { port: found.port || service.port || 80 }),
  };
  const domains = [...(service.domains || []).filter((d) => d.host !== host), entry];
  store.updateService(service.id, { domains });
  res.json({ ok: true, entry });
});

// One-click repair: rewrite the nginx config from the stored entry, put SSL
// back (reusing the existing certificate when there is one), reload and
// probe. Covers "folder deleted and redeployed", lost 443 blocks and missing
// symlinks without detaching the domain.
router.post('/:id/domains/:host/repair', requirePerm('domainsService'), async (req, res) => {
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

// ?keep=1 detaches db-only — the nginx config and certificate stay. Used for
// adopted domains whose config the panel never wrote (external sites).
router.delete('/:id/domains/:host', requirePerm('domainsService'), async (req, res) => {
  const service = store.getService(req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const entry = (service.domains || []).find((d) => d.host === req.params.host);
  if (req.query.keep !== '1') {
    if (entry?.https) await nginx.deleteHttps(entry.host); // drop the certificate too
    try {
      await nginx.deleteSite(req.params.host);
    } catch {
      /* ignore */
    }
  }
  const domains = (service.domains || []).filter((d) => d.host !== req.params.host);
  store.updateService(service.id, { domains });
  res.json({ ok: true });
});

export default router;
