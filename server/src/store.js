import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { seal, unseal } from './services/secretbox.js';

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
    data.admins ||= [];
    data.servers ||= []; // other panels linked for project transfer
    data.transfers ||= []; // project transfer history
    data.settings ||= {}; // panel-wide switches
    return data;
  } catch {
    return { projects: [], services: [], deployments: [], admins: [], servers: [], transfers: [], settings: {} };
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

/* ----------------------------------------------------------------- Settings
 * Panel-wide switches. Only non-secret preferences live here — passwords and
 * keys stay in server/.env, which the panel never writes.
 */

const DEFAULT_SETTINGS = {
  // Redeploy the panel itself when a push lands on its own repo.
  selfUpdateAuto: false,
  // Access key for the MCP endpoint (/mcp). Empty = MCP is off. It is shown
  // in the panel on purpose: it has to be pasted into a Claude config, and
  // the owner already knows every other secret on this box.
  mcpKey: '',
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read().settings };
}

/** Patch the known keys only — an unknown key from a request is ignored. */
export function updateSettings(patch = {}) {
  const db = read();
  const next = { ...DEFAULT_SETTINGS, ...db.settings };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in patch) next[key] = patch[key];
  }
  db.settings = next;
  write(db);
  return { ...next };
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
  if ('pinned' in patch) p.pinned = !!patch.pinned;
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

// A single repo may be wired into several services — e.g. a project copied
// from another keeps the same repoFullName. A webhook push must reach them
// ALL, not just the first match, so this returns every service for the repo.
export function getServicesByRepo(fullName) {
  if (!fullName) return [];
  const db = read();
  const wanted = fullName.toLowerCase();
  return db.services
    .filter((x) => (x.repoFullName || '').toLowerCase() === wanted)
    .map((s) => withLatestDeployment(db, s));
}

// pm2 process name is always derived from the service name — never user-set.
// pm2 process names must be unique across the whole box, but service names
// only need to be unique within their project ("server", "admin", ...), so
// the process name is derived from both: <project-slug>-<service-slug>.
export function pm2NameFrom(projectName, serviceName) {
  const proj = slugify(projectName || 'project');
  const svc = slugify(serviceName || 'service');
  return svc === proj || svc.startsWith(`${proj}-`) ? svc : `${proj}-${svc}`;
}

const pm2NameFor = (db, service) => {
  const project = db.projects.find((p) => p.id === service.projectId);
  return pm2NameFrom(project?.name, service.name);
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

/**
 * A deployment left in building/deploying when the panel starts is dead —
 * its child processes died with the previous panel process. Without this it
 * shows "Building…" forever in the UI.
 */
export function failOrphanedDeployments() {
  const db = read();
  let n = 0;
  for (const d of db.deployments) {
    if (['building', 'deploying'].includes(d.status)) {
      d.status = 'failed';
      d.finishedAt = now();
      d.logs.push({ ts: now(), stream: 'stderr', line: 'Deployment interrupted — the panel was restarted mid-deploy. Run it again.' });
      n++;
    }
  }
  if (n) write(db);
  return n;
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

/** Reverse lookup for WS actions that only carry a pm2 name (log streams). */
export function findServiceByPm2Name(pm2Name) {
  const db = read();
  return db.services.find((s) => (s.pm2Name || s.name) === pm2Name) || null;
}

/* ------------------------------------------------------------------ Admins */
// Additional admins created by the owner. The password IS the identity
// (login stays password-only), so passwords must be unique — enforced in the
// admins routes. Only the scrypt hash is ever stored or returned.

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

export function checkPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const probe = crypto.scryptSync(password, salt, 32);
  const target = Buffer.from(hash, 'hex');
  return probe.length === target.length && crypto.timingSafeEqual(probe, target);
}

const publicAdmin = ({ passwordHash, ...rest }) => rest;

export function listAdmins() {
  return read().admins.map(publicAdmin);
}

export function getAdmin(adminId) {
  const a = read().admins.find((x) => x.id === adminId);
  return a ? publicAdmin(a) : null;
}

export function findAdminByPassword(password) {
  for (const a of read().admins) {
    if (checkPassword(password, a.passwordHash)) return publicAdmin(a);
  }
  return null;
}

export function createAdmin({ name, password, permissions = {}, projects = [] }) {
  const db = read();
  const admin = {
    id: id(),
    name: String(name || '').trim() || 'admin',
    passwordHash: hashPassword(password),
    permissions, // { permissionKey: boolean }
    projects, // 'all' | [projectId, ...]
    disabled: false,
    createdAt: now(),
  };
  db.admins.push(admin);
  write(db);
  return publicAdmin(admin);
}

export function updateAdmin(adminId, patch) {
  const db = read();
  const a = db.admins.find((x) => x.id === adminId);
  if (!a) return null;
  if ('name' in patch) a.name = String(patch.name || '').trim() || a.name;
  if (patch.permissions && typeof patch.permissions === 'object') a.permissions = patch.permissions;
  if ('projects' in patch) {
    a.projects = patch.projects === 'all' ? 'all' : Array.isArray(patch.projects) ? patch.projects : a.projects;
  }
  if ('disabled' in patch) a.disabled = Boolean(patch.disabled);
  if (typeof patch.password === 'string' && patch.password) a.passwordHash = hashPassword(patch.password);
  write(db);
  return publicAdmin(a);
}

export function deleteAdmin(adminId) {
  const db = read();
  const before = db.admins.length;
  db.admins = db.admins.filter((x) => x.id !== adminId);
  write(db);
  return db.admins.length < before;
}

/* ----------------------------------------------------------------- Servers */
// Other machines running this same panel, linked once by URL + their admin
// password so projects can be moved between them. The password is stored
// SEALED (see services/secretbox.js) because we must replay it to log in
// again when the remote session token expires — the UI only ever sees
// `hasPassword`.

const publicServer = ({ password, ...rest }) => ({ ...rest, hasPassword: Boolean(password) });

export function listServers() {
  return read().servers.map(publicServer);
}

export function getServer(serverId) {
  const s = read().servers.find((x) => x.id === serverId);
  return s ? publicServer(s) : null;
}

/** Internal: the row WITH its decrypted password (null = cannot be opened). */
export function getServerSecret(serverId) {
  const s = read().servers.find((x) => x.id === serverId);
  if (!s) return null;
  return { ...s, password: s.password ? unseal(s.password) : null };
}

export function createServer({ name, url, password, insecure = false }) {
  const db = read();
  const server = {
    id: id(),
    name: String(name || '').trim() || url,
    url: String(url || '').trim(),
    password: password ? seal(password) : '',
    insecure: Boolean(insecure),
    info: null, // { hostname, panel, protocol, projectsRoot } from the last check
    lastSeenAt: null,
    lastError: '',
    createdAt: now(),
  };
  db.servers.push(server);
  write(db);
  return publicServer(server);
}

export function updateServer(serverId, patch) {
  const db = read();
  const s = db.servers.find((x) => x.id === serverId);
  if (!s) return null;
  if ('name' in patch) s.name = String(patch.name || '').trim() || s.name;
  if ('url' in patch && patch.url) s.url = String(patch.url).trim();
  if ('insecure' in patch) s.insecure = Boolean(patch.insecure);
  if (typeof patch.password === 'string' && patch.password) s.password = seal(patch.password);
  if ('info' in patch) s.info = patch.info;
  if ('lastSeenAt' in patch) s.lastSeenAt = patch.lastSeenAt;
  if ('lastError' in patch) s.lastError = String(patch.lastError || '');
  write(db);
  return publicServer(s);
}

export function deleteServer(serverId) {
  const db = read();
  const before = db.servers.length;
  db.servers = db.servers.filter((x) => x.id !== serverId);
  write(db);
  return db.servers.length < before;
}

/* --------------------------------------------------------------- Transfers */
// Persisted history of project moves. The LIVE job (progress, streaming log)
// lives in memory in services/transfer.js — only snapshots land here, so a
// chatty transfer doesn't rewrite db.json on every line.

const TRANSFER_HISTORY = 50;

export function saveTransfer(row) {
  const db = read();
  const i = db.transfers.findIndex((t) => t.id === row.id);
  if (i >= 0) db.transfers[i] = row;
  else db.transfers.push(row);
  db.transfers.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  if (db.transfers.length > TRANSFER_HISTORY) db.transfers = db.transfers.slice(0, TRANSFER_HISTORY);
  write(db);
  return row;
}

export function listTransfers() {
  return read().transfers;
}

export function getTransfer(transferId) {
  return read().transfers.find((t) => t.id === transferId) || null;
}

export function deleteTransfer(transferId) {
  const db = read();
  const before = db.transfers.length;
  db.transfers = db.transfers.filter((t) => t.id !== transferId);
  write(db);
  return db.transfers.length < before;
}

/**
 * Recreate a whole project from a transfer bundle manifest, in ONE write:
 * the project row, its services (with their new absolute paths and resolved
 * ports) and — optionally — their deployment history. Ids are always fresh;
 * everything else is carried over verbatim so the imported project looks
 * exactly like the original.
 */
export function importProject({ project, services, deployments = [] }) {
  const db = read();
  const projectRow = {
    id: id(),
    name: project.name,
    description: project.description || '',
    path: project.path,
    createdAt: validIso(project.createdAt) || now(),
    createdAtHistory: Array.isArray(project.createdAtHistory) ? project.createdAtHistory : [],
    ...(project.pinned ? { pinned: true } : {}),
    importedAt: now(),
  };
  db.projects.push(projectRow);

  const created = [];
  const idBySlug = new Map();
  for (const svc of services) {
    const row = {
      id: id(),
      projectId: projectRow.id,
      name: svc.name || 'service',
      icon: svc.icon || 'box',
      sourceType: svc.sourceType || 'github',
      repoUrl: svc.repoUrl || '',
      repoFullName: svc.repoFullName || '',
      branch: svc.branch || 'main',
      rootDirectory: svc.rootDirectory || '',
      localPath: svc.localPath || '',
      serviceKind: svc.serviceKind || 'auto',
      buildCommand: svc.buildCommand || '',
      startCommand: svc.startCommand || '',
      staticOutputDir: svc.staticOutputDir || '',
      pm2Name: '',
      port: svc.port || '',
      autoDeploy: Boolean(svc.autoDeploy),
      domains: Array.isArray(svc.domains) ? svc.domains : [],
      variables: svc.variables || {},
      createdAt: validIso(svc.createdAt) || now(),
      createdAtHistory: Array.isArray(svc.createdAtHistory) ? svc.createdAtHistory : [],
      importedAt: now(),
    };
    // A pinned pm2 name belongs to a process that predates the panel's
    // naming scheme — it must survive the move untouched. Everything else
    // gets the local <project>-<service> name.
    if (svc.pm2NamePinned && svc.pm2Name) {
      row.pm2Name = svc.pm2Name;
      row.pm2NamePinned = true;
    } else {
      row.pm2Name = pm2NameFor(db, row);
    }
    db.services.push(row);
    created.push(row);
    if (svc.slug) idBySlug.set(svc.slug, row.id);
  }

  for (const dep of deployments) {
    const serviceId = idBySlug.get(dep.serviceSlug);
    if (!serviceId) continue;
    db.deployments.push({
      ...dep,
      id: id(),
      serviceId,
      serviceSlug: undefined,
      imported: true,
    });
  }

  write(db);
  return { project: projectRow, services: created };
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
