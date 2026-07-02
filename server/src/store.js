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

export function createProject({ name, description = '' }) {
  const db = read();
  const project = {
    id: id(),
    name,
    description,
    path: path.join(config.projectsRoot, slugify(name)),
    createdAt: now(),
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
const pm2NameFor = (name) => String(name || 'service').trim().replace(/\s+/g, '-');

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
    pm2Name: pm2NameFor(input.name),
    port: input.port || '',
    // deploy behaviour
    autoDeploy: Boolean(input.autoDeploy),
    // networking
    domains: input.domains || [], // [{ host, https }]
    // env
    variables: input.variables || {}, // { KEY: value }
    createdAt: now(),
  };
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
  if ('name' in patch) s.pm2Name = pm2NameFor(s.name); // pm2 name follows the service name
  s.updatedAt = now();
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
