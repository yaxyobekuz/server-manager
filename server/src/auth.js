import jwt from 'jsonwebtoken';
import { config } from './config.js';
import * as store from './store.js';

/**
 * Password-only auth with two tiers:
 *  - the OWNER logs in with ADMIN_PASSWORD from server/.env — full access,
 *    including the Admins section;
 *  - additional admins (created by the owner) log in with their own unique
 *    password and carry a per-admin permission set + project scope.
 * The password IS the identity — no usernames, matching the original design.
 */

// Everything an admin can be allowed (or denied). The client renders its
// permission checkboxes from this catalog, so a new capability only needs a
// line here plus a requirePerm() on its routes.
export const PERMISSIONS = [
  { key: 'deploy', label: 'Deploy & restart services', group: 'Projects & services' },
  { key: 'editServices', label: 'Create & edit projects/services (settings, copy, pin)', group: 'Projects & services' },
  { key: 'deleteServices', label: 'Delete projects & services', group: 'Projects & services' },
  { key: 'variables', label: 'View & edit variables (.env)', group: 'Projects & services' },
  { key: 'logs', label: 'View service logs', group: 'Viewing' },
  { key: 'metrics', label: 'View metrics & traffic', group: 'Viewing' },
  { key: 'statistics', label: 'Statistics page', group: 'Viewing' },
  { key: 'processes', label: 'Processes page', group: 'Viewing' },
  { key: 'serverInfo', label: 'Information page (server details & speed test)', group: 'Viewing' },
  { key: 'domainsService', label: 'Manage service domains (add, repair, delete)', group: 'Domains' },
  { key: 'domainsGlobal', label: 'Global Domains page (scan, attach, full delete)', group: 'Domains' },
  { key: 'terminal', label: 'Terminal (global page & per-service shell)', group: 'Danger zone' },
  { key: 'processControl', label: 'Process actions (restart / stop / delete)', group: 'Danger zone' },
];

export function login(password) {
  if (!config.adminPassword) {
    return { ok: false, error: 'Admin password is not configured on the server.' };
  }
  if (password === config.adminPassword) {
    const token = jwt.sign({ role: 'owner' }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    return { ok: true, token };
  }
  const admin = store.findAdminByPassword(password);
  if (admin && !admin.disabled) {
    const token = jwt.sign({ role: 'admin', adminId: admin.id }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
    });
    return { ok: true, token };
  }
  return { ok: false, error: 'Incorrect password.' };
}

/**
 * Fresh auth context from a verified token payload (null = reject). Admin
 * permissions are re-read from the store on every request, so an owner's
 * permission change or disable applies immediately — not at next login.
 */
export function authFrom(payload) {
  if (!payload) return null;
  // Tokens minted before the admins feature carried role 'admin' with no id —
  // they belonged to the single owner password.
  if (payload.role === 'owner' || (payload.role === 'admin' && !payload.adminId)) {
    return { role: 'owner', name: 'owner' };
  }
  const admin = store.getAdmin(payload.adminId);
  if (!admin || admin.disabled) return null;
  return {
    role: 'admin',
    adminId: admin.id,
    name: admin.name,
    permissions: admin.permissions || {},
    projects: admin.projects ?? [],
  };
}

/** Express middleware — rejects requests without a valid token. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const auth = authFrom(jwt.verify(token, config.jwtSecret));
    if (!auth) return res.status(401).json({ error: 'Invalid or expired token' });
    req.auth = auth;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function can(auth, perm) {
  return auth?.role === 'owner' || Boolean(auth?.permissions?.[perm]);
}

export function canProject(auth, projectId) {
  if (auth?.role === 'owner' || auth?.projects === 'all') return true;
  return Array.isArray(auth?.projects) && auth.projects.includes(projectId);
}

export function requirePerm(perm) {
  return (req, res, next) =>
    can(req.auth, perm) ? next() : res.status(403).json({ error: `Permission denied (${perm})` });
}

export function requireOwner(req, res, next) {
  return req.auth?.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only' });
}

/** Verify a token string directly (used by the WebSocket handshake). */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}
