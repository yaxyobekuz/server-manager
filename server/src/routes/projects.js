import fs from 'node:fs';
import { Router } from 'express';
import * as store from '../store.js';
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
