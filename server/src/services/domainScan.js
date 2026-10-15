import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as store from '../store.js';

/**
 * Server-wide domain inventory, read from what the machine actually has:
 * every nginx vhost in sites-available (managed by the panel or not) plus
 * every Let's Encrypt certificate — merged with the panel's own db so each
 * host shows which service it belongs to, if any.
 *
 * Read-only: scanning never touches nginx or certbot. Attaching a found
 * domain to a service ("adopt") is a db-only write in the services routes.
 */

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const LE_LIVE = '/etc/letsencrypt/live';

/** Top-level `server { … }` block bodies, comments stripped. */
function serverBlocks(text) {
  const clean = text
    .split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n');
  const blocks = [];
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') depth--;
    }
    blocks.push(clean.slice(m.index + m[0].length, i - 1));
    re.lastIndex = i;
  }
  return blocks;
}

function parseBlock(b) {
  const hosts = (b.match(/server_name\s+[^;]+;/g) || [])
    .flatMap((s) => s.replace(/server_name|;/g, '').trim().split(/\s+/))
    .filter((h) => h && h !== '_');
  const listens = [...b.matchAll(/listen\s+([^;]+);/g)].map((x) => x[1]);
  const ssl = listens.some((l) => /(^|[\s:])443\b/.test(l) && /\bssl\b/.test(l));
  const proxy = b.match(/proxy_pass\s+\w+:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::(\d+))?/);
  const rootM = b.match(/(?:^|\s)root\s+([^;]+);/);
  return {
    hosts,
    ssl,
    port: proxy ? Number(proxy[1] || 80) : null,
    root: rootM ? rootM[1].trim() : null,
  };
}

/** All hosts found in nginx confs: host → best conf {file, enabled, managed, ssl, port, root}. */
function scanConfs() {
  const byHost = new Map();
  if (!fs.existsSync(SITES_AVAILABLE)) return byHost;
  for (const file of fs.readdirSync(SITES_AVAILABLE)) {
    if (file === 'README' || /\.bak(\.|$)/.test(file) || file.endsWith('~')) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(SITES_AVAILABLE, file), 'utf8');
    } catch {
      continue;
    }
    const enabled = fs.existsSync(path.join(SITES_ENABLED, file));
    const managed = raw.includes('Managed by server-manager');
    // Merge across the file's server blocks (http + https + redirect blocks
    // describe the same host): ssl if ANY block terminates TLS; target from
    // whichever block actually proxies or serves files.
    const perFile = new Map();
    for (const block of serverBlocks(raw)) {
      const p = parseBlock(block);
      for (const host of p.hosts) {
        const cur = perFile.get(host) || { ssl: false, port: null, root: null };
        cur.ssl = cur.ssl || p.ssl;
        if (p.port || p.root) {
          cur.port = cur.port ?? p.port;
          cur.root = cur.root ?? p.root;
        }
        perFile.set(host, cur);
      }
    }
    for (const [host, info] of perFile) {
      const entry = { file, enabled, managed, ...info };
      const prev = byHost.get(host);
      // A host can appear in several files (backups, www aliases) — the
      // enabled conf is the one nginx actually serves.
      if (!prev || (entry.enabled && !prev.enabled)) byHost.set(host, entry);
    }
  }
  return byHost;
}

// openssl output cached per cert file mtime — certs change rarely.
const certCache = new Map(); // name → {mtime, info}

function certInfo(name) {
  const pem = path.join(LE_LIVE, name, 'cert.pem');
  let mtime;
  try {
    mtime = fs.statSync(pem).mtimeMs;
  } catch {
    return null;
  }
  const hit = certCache.get(name);
  if (hit && hit.mtime === mtime) return hit.info;
  let info = null;
  try {
    const out = execFileSync(
      'openssl',
      ['x509', '-noout', '-enddate', '-ext', 'subjectAltName', '-in', pem],
      { timeout: 5000 }
    ).toString();
    const end = out.match(/notAfter=(.+)/);
    const expiresAt = end ? new Date(end[1]) : null;
    info = {
      name,
      expiresAt: expiresAt?.toISOString() || null,
      daysLeft: expiresAt ? Math.floor((expiresAt - Date.now()) / 86400000) : null,
      hosts: [...out.matchAll(/DNS:([^\s,]+)/g)].map((x) => x[1]),
    };
  } catch {
    /* unreadable cert — reported as missing */
  }
  certCache.set(name, { mtime, info });
  return info;
}

function scanCerts() {
  if (!fs.existsSync(LE_LIVE)) return [];
  return fs
    .readdirSync(LE_LIVE)
    .filter((n) => n !== 'README' && fs.existsSync(path.join(LE_LIVE, n, 'cert.pem')))
    .map(certInfo)
    .filter(Boolean);
}

// The filesystem part is the slow part (46 confs + 39 openssl reads) — cache
// it briefly. Panel attachments are merged fresh on every call so an adopt
// shows up immediately.
let fsCache = { at: 0, confs: null, certs: null };
const FS_TTL = 60_000;

export function scanDomains(force = false) {
  if (force || !fsCache.confs || Date.now() - fsCache.at > FS_TTL) {
    fsCache = { at: Date.now(), confs: scanConfs(), certs: scanCerts() };
  }
  const { confs, certs } = fsCache;

  const certByHost = new Map();
  for (const c of certs) for (const h of c.hosts) if (!certByHost.has(h)) certByHost.set(h, c);

  // Panel attachments: host → {service, project}; plus every service for
  // port-match suggestions on unattached hosts.
  const attached = new Map();
  const allServices = [];
  for (const p of store.listProjects()) {
    for (const s of p.services || []) {
      allServices.push({ id: s.id, name: s.name, port: s.port, projectId: p.id, projectName: p.name });
      for (const d of s.domains || []) {
        attached.set(d.host, {
          id: s.id,
          name: s.name,
          projectId: p.id,
          projectName: p.name,
          https: Boolean(d.https),
        });
      }
    }
  }

  const domains = [];
  for (const [host, conf] of confs) {
    const service = attached.get(host) || null;
    const suggestion =
      !service && conf.port
        ? allServices.find((s) => Number(s.port) === conf.port) || null
        : null;
    domains.push({
      host,
      file: conf.file,
      enabled: conf.enabled,
      managed: conf.managed,
      ssl: conf.ssl,
      port: conf.port,
      root: conf.root,
      cert: certByHost.get(host) || null,
      service,
      suggestion: suggestion
        ? { serviceId: suggestion.id, serviceName: suggestion.name, projectName: suggestion.projectName }
        : null,
    });
  }
  // Certificates with no vhost at all (site deleted, cert left behind).
  for (const [host, cert] of certByHost) {
    if (confs.has(host)) continue;
    domains.push({
      host,
      file: null,
      enabled: false,
      managed: false,
      ssl: false,
      port: null,
      root: null,
      cert,
      service: attached.get(host) || null,
      suggestion: null,
    });
  }
  domains.sort((a, b) => a.host.localeCompare(b.host));

  const counts = {
    total: domains.length,
    active: domains.filter((d) => d.enabled).length,
    https: domains.filter((d) => d.ssl && d.cert && d.cert.daysLeft > 0).length,
    attached: domains.filter((d) => d.service).length,
    unattached: domains.filter((d) => !d.service).length,
    expiring: domains.filter((d) => d.cert && d.cert.daysLeft <= 21).length,
  };
  return { scannedAt: new Date(fsCache.at).toISOString(), counts, domains };
}

/** One host's scan entry (cached) — used by the adopt route and status API. */
export function findHost(host, force = false) {
  return scanDomains(force).domains.find((d) => d.host === host) || null;
}
