import * as store from '../store.js';
import * as pm2 from './pm2.js';
import { teardownService, removeFolder } from './teardown.js';

/**
 * Project-wide operations shared by the HTTP routes and the transfer engine:
 * powering every service of a project on/off, and deleting a project with
 * everything it owns. Kept here so a move behaves exactly like the buttons.
 */

/** Static sites have no process — nginx keeps serving them regardless. */
export function runnableServices(project) {
  return (project.services || []).filter((s) => (s.serviceKind || 'auto') !== 'static');
}

export async function projectProcesses(project) {
  const byName = new Map((await pm2.list()).map((p) => [p.name, p]));
  return runnableServices(project).map((s) => {
    const name = s.pm2Name || s.name;
    return { serviceId: s.id, service: s.name, pm2Name: name, status: byName.get(name)?.status || 'not running' };
  });
}

/**
 * Stop or start every pm2 process the project owns. Services that were never
 * deployed (no pm2 process yet) are skipped, not failed. The state is saved
 * so a stopped project stays stopped across server reboots.
 */
export async function bulkPm2(project, verb) {
  const byName = new Map((await pm2.list()).map((p) => [p.name, p]));
  const results = [];
  for (const s of runnableServices(project)) {
    const name = s.pm2Name || s.name;
    if (!byName.has(name)) {
      results.push({ service: s.name, pm2Name: name, ok: true, skipped: true, output: 'no pm2 process (never deployed)' });
      continue;
    }
    try {
      await (verb === 'stop' ? pm2.stop(name) : pm2.start(name));
      results.push({ service: s.name, pm2Name: name, ok: true });
    } catch (e) {
      results.push({ service: s.name, pm2Name: name, ok: false, output: e.message });
    }
  }
  if (results.some((r) => r.ok && !r.skipped)) await pm2.save().catch(() => {});
  return results;
}

/**
 * Delete a project the way the Delete button does: every service torn down
 * one by one (pm2 process, domains with nginx + certbot, service folder),
 * then the project folder, then the db rows.
 */
export async function deleteProjectCompletely(project) {
  const cleanup = [];
  for (const svc of project.services || []) {
    cleanup.push({ service: svc.name, ...(await teardownService(svc)) });
    store.deleteService(svc.id);
  }
  const folder = removeFolder(store.projectPath(project));
  store.deleteProject(project.id);
  return { cleanup, folder };
}
