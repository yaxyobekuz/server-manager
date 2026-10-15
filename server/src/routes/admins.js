import { Router } from 'express';
import * as store from '../store.js';
import { config } from '../config.js';
import { PERMISSIONS } from '../auth.js';

// Mounted behind requireAuth + requireOwner — only the owner manages admins.
const router = Router();

router.get('/permissions', (req, res) => {
  res.json({ permissions: PERMISSIONS });
});

router.get('/', (req, res) => {
  res.json({ admins: store.listAdmins() });
});

// The password is the login identity, so it must be unique across the owner
// and every admin — otherwise logins would be ambiguous.
function passwordProblem(password, exceptId) {
  if (typeof password !== 'string' || password.length < 6) {
    return 'Password must be at least 6 characters.';
  }
  if (password === config.adminPassword) return 'This password is already used by the owner.';
  const clash = store.findAdminByPassword(password);
  if (clash && clash.id !== exceptId) return `Another admin (${clash.name}) already uses this password.`;
  return null;
}

router.post('/', (req, res) => {
  const { name, password, permissions = {}, projects = [] } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const bad = passwordProblem(password);
  if (bad) return res.status(400).json({ error: bad });
  res.status(201).json({ admin: store.createAdmin({ name, password, permissions, projects }) });
});

router.patch('/:id', (req, res) => {
  const patch = { ...(req.body || {}) };
  if (typeof patch.password === 'string' && patch.password) {
    const bad = passwordProblem(patch.password, req.params.id);
    if (bad) return res.status(400).json({ error: bad });
  } else {
    delete patch.password; // empty = keep the current one
  }
  const admin = store.updateAdmin(req.params.id, patch);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  res.json({ admin });
});

router.delete('/:id', (req, res) => {
  res.json({ ok: store.deleteAdmin(req.params.id) });
});

export default router;
