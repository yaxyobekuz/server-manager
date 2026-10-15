import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import * as store from '../store.js';
import { canProject, requirePerm } from '../auth.js';
import { startDeployment } from '../services/deploy.js';
import { teardownService, removeFolder } from '../services/teardown.js';
import * as pm2 from '../services/pm2.js';

const router = Router();

// Every /:id route is scoped: an admin only reaches projects on their list.
router.param('id', (req, res, next, projectId) => {
  if (!canProject(req.auth, projectId)) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  next();
});

// A scoped admin who creates a project must also see it afterwards.
function grantToCreator(auth, projectId) {
  if (auth.role === 'admin' && Array.isArray(auth.projects)) {
    store.updateAdmin(auth.adminId, { projects: [...auth.projects, projectId] });
  }
}

router.get('/', (req, res) => {
  res.json({ projects: store.listProjects().filter((p) => canProject(req.auth, p.id)) });
});

router.post('/', requirePerm('editServices'), (req, res) => {
  const { name, description, createdAt, createdAtNote } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const project = store.createProject({ name, description, createdAt, createdAtNote });
  grantToCreator(req.auth, project.id);
  try {
    fs.mkdirSync(project.path, { recursive: true }); // /var/www/<project>
  } catch {
    /* deploy re-creates it; folder trouble must not block the project */
  }
  res.status(201).json({ project });
});

router.get('/:id', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project });
});

router.patch('/:id', requirePerm('editServices'), (req, res) => {
  const project = store.updateProject(req.params.id, req.body || {});
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project });
});

// Admin-editable creation date; every change lands in createdAtHistory.
router.put('/:id/created-at', requirePerm('editServices'), (req, res) => {
  const { createdAt, note } = req.body || {};
  const project = store.setProjectCreatedAt(req.params.id, createdAt, note);
  if (!project) return res.status(400).json({ error: 'Project not found or createdAt is not a valid date' });
  res.json({ project });
});

/* ------------------------------------------------------------- stop/start */
// A project's runnable services are its non-static ones; static sites have
// no process (nginx keeps serving them regardless).

function runnableServices(project) {
  return (project.services || []).filter((s) => (s.serviceKind || 'auto') !== 'static');
}

// Live pm2 state of the project's services — drives the Stop/Start buttons.
router.get('/:id/processes', async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const byName = new Map((await pm2.list()).map((p) => [p.name, p]));
  res.json({
    processes: runnableServices(project).map((s) => {
      const name = s.pm2Name || s.name;
      return { serviceId: s.id, service: s.name, pm2Name: name, status: byName.get(name)?.status || 'not running' };
    }),
  });
});

// Stop or start every pm2 process the project owns. Services that were never
// deployed (no pm2 process yet) are skipped, not failed. The state is saved
// so a stopped project stays stopped across server reboots.
async function bulkPm2(project, verb) {
  const byName = new Map((await pm2.list()).map((p) => [p.name, p]));
  const results = [];
  for (const s of runnableServices(project)) {
    const name = s.pm2Name || s.name;
    if (!byName.has(name)) {
      results.push({ service: s.name, pm2Name: name, ok: true, skipped: true, output: 'no pm2 process (never deployed)' });
      continue;
    }
    try {
      await (verb === 'stop' ? pm2.stop(name) : pm2.start(name));
      results.push({ service: s.name, pm2Name: name, ok: true });
    } catch (e) {
      results.push({ service: s.name, pm2Name: name, ok: false, output: e.message });
    }
  }
  if (results.some((r) => r.ok && !r.skipped)) await pm2.save().catch(() => {});
  return results;
}

router.post('/:id/stop', requirePerm('deploy'), async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const results = await bulkPm2(project, 'stop');
  res.json({ ok: results.every((r) => r.ok), results });
});

router.post('/:id/start', requirePerm('deploy'), async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const results = await bulkPm2(project, 'start');
  res.json({ ok: results.every((r) => r.ok), results });
});

// Duplicate a project: every service is recreated with the same config and
// variables but a fresh folder under the new project — and NO domains, ever
// (two services can't share a host; a copy always gets new domains).
// Services listed in deployServiceIds are deployed immediately; the rest are
// just created and wait until the admin deploys them.
router.post('/:id/copy', requirePerm('editServices'), async (req, res) => {
  const source = store.getProject(req.params.id);
  if (!source) return res.status(404).json({ error: 'Project not found' });

  const name = String(req.body?.name || `${source.name}-copy`).trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const slug = store.slugify(name);
  if (store.listProjects().some((p) => store.slugify(p.name) === slug)) {
    return res.status(400).json({ error: `A project with the name "${name}" already exists — pick another name.` });
  }
  const deployIds = new Set(req.body?.deployServiceIds || []);

  const project = store.createProject({ name, description: source.description });
  grantToCreator(req.auth, project.id);
  try {
    fs.mkdirSync(project.path, { recursive: true });
  } catch {
    /* deploy re-creates it */
  }

  const services = [];
  const deployed = [];
  for (const svc of source.services || []) {
    const localPath = path.join(store.projectPath(project), store.slugify(svc.name));
    const copy = store.createService(project.id, {
      name: svc.name,
      icon: svc.icon,
      sourceType: svc.sourceType,
      repoUrl: svc.repoUrl,
      repoFullName: svc.repoFullName,
      branch: svc.branch,
      rootDirectory: svc.rootDirectory,
      localPath,
      serviceKind: svc.serviceKind,
      buildCommand: svc.buildCommand,
      startCommand: svc.startCommand,
      staticOutputDir: svc.staticOutputDir,
      port: svc.port,
      autoDeploy: svc.autoDeploy,
      variables: { ...(svc.variables || {}) },
      // domains deliberately omitted — never copied
    });
    // GitHub services clone on deploy; local-source services have no repo to
    // clone from, so carry the files over (minus node_modules — reinstalled).
    try {
      if (svc.sourceType === 'local' && svc.localPath && fs.existsSync(svc.localPath)) {
        await fs.promises.cp(svc.localPath, localPath, {
          recursive: true,
          filter: (src) => path.basename(src) !== 'node_modules',
        });
      } else {
        fs.mkdirSync(localPath, { recursive: true });
      }
    } catch {
      /* folder trouble surfaces on deploy, not here */
    }
    services.push(copy);
    if (deployIds.has(svc.id)) {
      startDeployment(copy, { trigger: 'copy' });
      deployed.push(copy.name);
    }
  }

  res.status(201).json({ project: { ...project, services }, deployed });
});

// Deleting a project tears its services down one by one (pm2, domains with
// nginx+certbot, service folders), then removes the project folder itself.
router.delete('/:id', requirePerm('deleteServices'), async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const cleanup = [];
    for (const svc of project.services || []) {
      cleanup.push({ service: svc.name, ...(await teardownService(svc)) });
      store.deleteService(svc.id);
    }
    const folder = removeFolder(store.projectPath(project));
    store.deleteProject(project.id);
    res.json({ ok: true, folder, cleanup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
