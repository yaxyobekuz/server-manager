import { Router } from 'express';
import * as store from '../store.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ projects: store.listProjects() });
});

router.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.status(201).json({ project: store.createProject({ name, description }) });
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

router.delete('/:id', (req, res) => {
  const ok = store.deleteProject(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

export default router;
