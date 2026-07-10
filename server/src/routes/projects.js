import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import * as store from '../store.js';
import { startDeployment } from '../services/deploy.js';
import { teardownService, removeFolder } from '../services/teardown.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ projects: store.listProjects() });
});

router.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const project = store.createProject({ name, description });
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

router.patch('/:id', (req, res) => {
  const project = store.updateProject(req.params.id, req.body || {});
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project });
});

// Duplicate a project: every service is recreated with the same config and
// variables but a fresh folder under the new project — and NO domains, ever
// (two services can't share a host; a copy always gets new domains).
// Services listed in deployServiceIds are deployed immediately; the rest are
// just created and wait until the admin deploys them.
router.post('/:id/copy', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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
