import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import * as nginx from './nginx.js';
import * as pm2 from './pm2.js';
import { config } from '../config.js';

/**
 * Full cleanup when a service or project is deleted: pm2 process, nginx
 * configs, certbot certificates and the folder on disk. Every step is
 * best-effort — a half-torn-down service must still end up deleted.
 */

/** Guarded rm -rf: refuses paths whose loss would be catastrophic. */
export function removeFolder(target) {
  if (!target) return { ok: false, reason: 'no path set' };
  const real = path.resolve(target);
  const panelRoot = path.resolve(config.rootDir);
  const depth = real.split('/').filter(Boolean).length;
  if (
    real === '/' ||
    depth < 2 || // /var, /home, /etc ...
    real === path.resolve(config.projectsRoot) || // /var/www itself
    real === panelRoot ||
    panelRoot.startsWith(real + '/') // ancestor of the panel — would kill it
  ) {
    return { ok: false, reason: `refused to delete protected path ${real}` };
  }
  try {
    fs.rmSync(real, { recursive: true, force: true });
    return { ok: true, path: real };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Tear down everything a service owns. Returns a summary per step. */
export async function teardownService(service, { removeFiles = true } = {}) {
  const result = { pm2: false, domains: [], folder: null };

  // 1. pm2 process (static services simply have none — delete just fails)
  const pm2Name = service.pm2Name || service.name;
  if (pm2Name) {
    try {
      await pm2.deleteProc(pm2Name);
      result.pm2 = true;
      await run('pm2', ['save'], { timeout: 15000 }); // don't resurrect on reboot
    } catch {
      /* no such process */
    }
  }

  // 2. domains: certificate first, then nginx config (+reload)
  for (const d of service.domains || []) {
    if (d.https) await nginx.deleteHttps(d.host);
    try {
      await nginx.deleteSite(d.host);
    } catch {
      /* already gone */
    }
    result.domains.push(d.host);
  }

  // 3. the service folder itself
  if (removeFiles) result.folder = removeFolder(service.localPath);
  return result;
}
