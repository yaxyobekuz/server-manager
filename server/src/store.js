import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * JSON-file backed store modelled after Railway:
 *   Project  -> has many Services
 *   Service  -> source (github repo or local path), variables, domains,
 *               build/start config, and a history of Deployments
 *   Deployment -> one build+release attempt with status and logs
 *
 * Everything lives in one file; a single VPS tool doesn't need a real DB.
 */

const FILE = path.join(config.dataDir, 'db.json');

function ensureFile() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ projects: [], services: [], deployments: [] }, null, 2));
  }
}

function read() {
  ensureFile();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data.projects ||= [];
    data.services ||= [];
    data.deployments ||= [];
    return data;
  } catch {
    return { projects: [], services: [], deployments: [] };
  }
}

function write(data) {
  ensureFile();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const validIso = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * createdAt is admin-editable (services predating the panel get their real
 * first-deploy date). Every change is recorded in createdAtHistory so the
 * audit trail stays visible: [{ from, to, at, note? }].
 */
function pushCreatedAt(row, iso, note) {
  row.createdAtHistory ||= [];
  row.createdAtHistory.push({ from: row.createdAt || null, to: iso, at: now(), ...(note ? { note } : {}) });
  row.createdAt = iso;
}

/* ----------------------------------------------------------------- Projects */

export function listProjects() {
  const db = read();
  return db.projects.map((p) => ({
    ...p,
    services: db.services.filter((s) => s.projectId === p.id),
  }));
}

export function getProject(projectId) {
  const db = read();
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) return null;
  return {
    ...project,
    services: db.services
      .filter((s) => s.projectId === projectId)
      .map((s) => withLatestDeployment(db, s)),
  };
}

/** Filesystem-safe folder name from a display name. */
export function slugify(name) {
  return (
    String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'app'
  );
}

/** Folder a project's services live under (stored at creation, never moved). */
export function projectPath(project) {
  return project.path || path.join(config.projectsRoot, slugify(project.name));
}

export function createProject({ name, description = '', createdAt, createdAtNote }) {
  const db = read();
  const backdated = validIso(createdAt); // registration of pre-existing work
  const project = {
    id: id(),
    name,
    description,
    path: path.join(config.projectsRoot, slugify(name)),
    createdAt: backdated || now(),
    createdAtHistory: backdated
      ? [{ from: null, to: backdated, at: now(), note: createdAtNote || 'set at registration' }]
      : [],
  };
  db.projects.push(project);
  write(db);
  return project;
}

export function updateProject(projectId, patch) {
  const db = read();
  const p = db.projects.find((x) => x.id === projectId);
  if (!p) return null;
  for (const k of ['name', 'description']) if (k in patch) p[k] = patch[k];
  write(db);
  return p;
}

export function deleteProject(projectId) {
  const db = read();
  const serviceIds = db.services.filter((s) => s.projectId === projectId).map((s) => s.id);
  db.deployments = db.deployments.filter((d) => !serviceIds.includes(d.serviceId));
  db.services = db.services.filter((s) => s.projectId !== projectId);
  const before = db.projects.length;
  db.projects = db.projects.filter((p) => p.id !== projectId);
  write(db);
  return db.projects.length < before;
}

/* ----------------------------------------------------------------- Services */

function withLatestDeployment(db, service) {
  const deps = db.deployments
    .filter((d) => d.serviceId === service.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ...service, latestDeployment: deps[0] || null, deploymentCount: deps.length };
}

export function getService(serviceId) {
  const db = read();
  const s = db.services.find((x) => x.id === serviceId);
  if (!s) return null;
  return withLatestDeployment(db, s);
}

export function getServiceByRepo(fullName) {
  if (!fullName) return null;
  const db = read();
  const wanted = fullName.toLowerCase();
  const s = db.services.find((x) => (x.repoFullName || '').toLowerCase() === wanted);
  return s ? withLatestDeployment(db, s) : null;
}

// pm2 process name is always derived from the service name — never user-set.
// pm2 process names must be unique across the whole box, but service names
// only need to be unique within their project ("server", "admin", ...), so
// the process name is derived from both: <project-slug>-<service-slug>.
const pm2NameFor = (db, service) => {
  const project = db.projects.find((p) => p.id === service.projectId);
  const proj = slugify(project?.name || 'project');
  const svc = slugify(service.name || 'service');
  return svc === proj || svc.startsWith(`${proj}-`) ? svc : `${proj}-${svc}`;
};

export function createService(projectId, input = {}) {
  const db = read();
  if (!db.projects.find((p) => p.id === projectId)) return null;
  const service = {
    id: id(),
    projectId,
    name: input.name || 'service',
    icon: input.icon || 'box',
    // source
    sourceType: input.sourceType || 'github', // 'github' | 'local'
    repoUrl: input.repoUrl || '',
    repoFullName: input.repoFullName || '',
    branch: input.branch || 'main',
    rootDirectory: input.rootDirectory || '',
    localPath: input.localPath || '', // absolute dir on the VPS
    // build / runtime
    serviceKind: input.serviceKind || 'auto', // 'auto' | 'backend' | 'static'
    buildCommand: input.buildCommand || '',
    startCommand: input.startCommand || '',
    staticOutputDir: input.staticOutputDir || '', // build output for static kind
    pm2Name: '', // derived below once the row exists
    port: input.port || '',
    // deploy behaviour
    autoDeploy: Boolean(input.autoDeploy),
    // networking
    domains: input.domains || [], // [{ host, https }]
    // env
    variables: input.variables || {}, // { KEY: value }
    createdAt: now(),
    createdAtHistory: [],
  };
  const backdated = validIso(input.createdAt); // registering pre-existing work
  if (backdated) {
    service.createdAt = backdated;
    service.createdAtHistory = [
      { from: null, to: backdated, at: now(), note: input.createdAtNote || 'set at registration' },
    ];
  }
  // Explicit pm2Name is for registering an ALREADY RUNNING process whose name
  // predates the panel's naming scheme — the process must not be renamed
  // (that would need a delete+start). Pinned names survive renames and the
  // boot-time normalization migration.
  if (typeof input.pm2Name === 'string' && input.pm2Name.trim()) {
    service.pm2Name = input.pm2Name.trim();
    service.pm2NamePinned = true;
  } else {
    service.pm2Name = pm2NameFor(db, service);
  }
  db.services.push(service);
  write(db);
  return service;
}

export function updateService(serviceId, patch) {
  const db = read();
  const s = db.services.find((x) => x.id === serviceId);
  if (!s) return null;
  const allowed = [
    'name', 'icon', 'sourceType', 'repoUrl', 'repoFullName', 'branch',
    'rootDirectory', 'localPath', 'serviceKind', 'buildCommand', 'startCommand',
    'staticOutputDir', 'port', 'autoDeploy', 'domains', 'variables',
  ];
  for (const k of allowed) if (k in patch) s[k] = patch[k];
  // pm2 name follows the service name — unless it was pinned at registration
  // to match a pre-existing process.
  if ('name' in patch && !s.pm2NamePinned) s.pm2Name = pm2NameFor(db, s);
  s.updatedAt = now();
  write(db);
  return s;
}

export function setProjectCreatedAt(projectId, createdAt, note) {
  const iso = validIso(createdAt);
  if (!iso) return null;
  const db = read();
  const p = db.projects.find((x) => x.id === projectId);
  if (!p) return null;
  pushCreatedAt(p, iso, note);
  write(db);
  return p;
}

export function setServiceCreatedAt(serviceId, createdAt, note) {
  const iso = validIso(createdAt);
  if (!iso) return null;
  const db = read();
  const s = db.services.find((x) => x.id === serviceId);
  if (!s) return null;
  pushCreatedAt(s, iso, note);
  write(db);
  return s;
}

export function deleteService(serviceId) {
  const db = read();
  db.deployments = db.deployments.filter((d) => d.serviceId !== serviceId);
  const before = db.services.length;
  db.services = db.services.filter((s) => s.id !== serviceId);
  write(db);
  return db.services.length < before;
}

/* -------------------------------------------------------------- Deployments */

export function listDeployments(serviceId) {
  const db = read();
  return db.deployments
    .filter((d) => d.serviceId === serviceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDeployment(deploymentId) {
  return read().deployments.find((d) => d.id === deploymentId) || null;
}

export function createDeployment(serviceId, { trigger = 'manual', commit = null } = {}) {
  const db = read();
  const deployment = {
    id: id(),
    serviceId,
    status: 'building', // building | deploying | success | failed | crashed | removed
    trigger, // manual | github | redeploy
    commit, // { hash, subject } | null
    logs: [], // [{ ts, stream, line }]
    createdAt: now(),
    finishedAt: null,
  };
  db.deployments.push(deployment);
  write(db);
  return deployment;
}

export function appendDeploymentLog(deploymentId, entry) {
  const db = read();
  const d = db.deployments.find((x) => x.id === deploymentId);
  if (!d) return;
  d.logs.push({ ts: now(), ...entry });
  if (d.logs.length > 2000) d.logs = d.logs.slice(-2000);
  write(db);
}

export function setDeploymentStatus(deploymentId, status) {
  const db = read();
  const d = db.deployments.find((x) => x.id === deploymentId);
  if (!d) return null;
  d.status = status;
  if (['success', 'failed', 'crashed', 'removed'].includes(status)) d.finishedAt = now();
  write(db);
  return d;
}

/** Mark all of a service's previous active deployments as superseded. */
export function supersedeActiveDeployments(serviceId, exceptId) {
  const db = read();
  for (const d of db.deployments) {
    if (d.serviceId === serviceId && d.id !== exceptId && d.status === 'success') {
      d.status = 'removed';
    }
  }
  write(db);
}

/* --------------------------------------------------------------- migration */
// Rows created before pm2 names were project-scoped may carry colliding names
// ("admin" in two projects). Recompute once at boot; no-op when already clean.
(function normalizePm2Names() {
  try {
    const db = read();
    let changed = false;
    for (const s of db.services) {
      if (s.pm2NamePinned) continue; // registered against a pre-existing process
      const want = pm2NameFor(db, s);
      if (s.pm2Name !== want) {
        s.pm2Name = want;
        changed = true;
      }
    }
    if (changed) write(db);
  } catch {
    /* never block boot on a migration */
  }
})();
