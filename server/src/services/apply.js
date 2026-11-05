import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run } from './exec.js';
import * as store from '../store.js';
import * as nginx from './nginx.js';
import * as pm2 from './pm2.js';
import * as domainScan from './domainScan.js';
import * as dbtools from './dbtools.js';
import * as envFile from './env.js';
import { startDeployment } from './deploy.js';
import { bulkPm2, deleteProjectCompletely } from './projectOps.js';
import {
  localInfo, normalizeOptions, unpackBundle, extractService, freeBytes, planFromManifest, formatSize,
} from './bundle.js';

/**
 * The receiving half of a project move, plus the two things the SOURCE does
 * for it (hold still while being copied, and stand down afterwards).
 *
 * Two rules shape everything here:
 *  - the source is never released until this side reports the project is
 *    actually up, so a failed move always leaves the original working;
 *  - if this side fails halfway it removes what it already created, so the
 *    operator never has to clean up a half-imported project by hand.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

/* -------------------------------------------------------------- utilities */

async function listeningPorts() {
  const ports = new Set();
  const r = await run('ss', ['-ltnH'], { timeout: 15000 });
  if (r.code !== 0) return ports;
  for (const line of String(r.stdout).split('\n')) {
    const addr = line.trim().split(/\s+/)[3] || '';
    const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
    if (Number.isFinite(port) && port > 0) ports.add(port);
  }
  return ports;
}

/** Ports this panel has already handed out → which service holds each. */
function panelPorts() {
  const byPort = new Map();
  for (const p of store.listProjects()) {
    for (const s of p.services || []) {
      const port = Number(s.port);
      if (port) byPort.set(port, `${p.name} / ${s.name}`);
    }
  }
  return byPort;
}

function nextFreePort(from, taken) {
  let port = Number(from) || 3000;
  while (taken.has(port) && port < 65000) port += 1;
  return port;
}

/** pm2 process names already in use here, panel-managed or not. */
function pm2NamesInUse(procs) {
  const names = new Map();
  for (const p of store.listProjects()) {
    for (const s of p.services || []) names.set(s.pm2Name || s.name, `${p.name} / ${s.name}`);
  }
  for (const proc of procs) if (!names.has(proc.name)) names.set(proc.name, 'a pm2 process outside the panel');
  return names;
}

const isEmptyDir = (dir) => {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
};

/* -------------------------------------------------------------- preflight */

/**
 * Can THIS server take the project described by `plan`? Answers with
 * blocking problems (the transfer refuses to start), warnings (it starts and
 * reports them) and the port re-mapping it would apply.
 */
export async function preflight(plan, optionsInput = {}) {
  const options = normalizeOptions({ ...(plan?.options || {}), ...optionsInput });
  const name = String(options.rename || plan?.project?.name || '').trim();
  if (!name) throw new Error('the plan carries no project name');
  const slug = store.slugify(name);
  const targetPath = path.join(config.projectsRoot, slug);
  const services = plan?.services || [];

  const blocking = [];
  const warnings = []; // something is off here and may need fixing
  const notes = []; // expected follow-up work no panel can do for you

  // 1. project identity ---------------------------------------------------
  if (store.listProjects().some((p) => store.slugify(p.name) === slug)) {
    blocking.push({
      code: 'project-exists',
      message: `this server already has a project called "${name}" — import it under another name`,
    });
  } else if (fs.existsSync(targetPath) && !isEmptyDir(targetPath)) {
    blocking.push({
      code: 'folder-exists',
      message: `${targetPath} already exists and is not empty — remove it (or use another name) so nothing gets overwritten`,
    });
  }

  // 2. pm2 process names. Two services of this panel can never collide (the
  // project slug is unique and the name is derived from it) — but a process
  // started outside the panel can, and a deploy replaces whatever holds the
  // name it wants.
  const names = pm2NamesInUse(await pm2.list().catch(() => []));
  for (const s of services) {
    const want = s.pm2NamePinned && s.pm2Name ? s.pm2Name : store.pm2NameFrom(name, s.name);
    if (!names.has(want)) continue;
    blocking.push({
      code: 'pm2-name',
      message:
        `the pm2 process "${want}" (${s.name}) already exists here, run by ${names.get(want)}` +
        ` — rename one of them, or stop and delete that process first`,
    });
  }

  // 3. ports --------------------------------------------------------------
  const held = panelPorts();
  const taken = new Set([...held.keys(), ...(await listeningPorts())]);
  const ports = [];
  for (const s of services) {
    const want = Number(s.port);
    if (!want) continue;
    if (taken.has(want)) {
      const to = nextFreePort(want + 1, taken);
      ports.push({ slug: s.slug, service: s.name, from: want, to, by: held.get(want) || 'another process on this server' });
      taken.add(to);
    } else {
      taken.add(want);
    }
  }

  // 4. domains ------------------------------------------------------------
  const scan = options.domains ? domainScan.scanDomains(true).domains : [];
  const domains = [];
  for (const s of services) {
    for (const d of s.domains || []) {
      const found = scan.find((x) => x.host === d.host);
      if (!options.domains) continue;
      if (!found) {
        domains.push({ host: d.host, state: 'free' });
      } else if (found.service) {
        domains.push({ host: d.host, state: 'taken', by: `${found.service.projectName} / ${found.service.name}` });
        blocking.push({
          code: 'domain-taken',
          message: `${d.host} is already attached here to ${found.service.projectName} / ${found.service.name} — detach it there first`,
        });
      } else {
        domains.push({ host: d.host, state: 'overwrite', by: found.file });
        warnings.push(`${d.host} already has an nginx config here (${found.file}) — it will be rewritten for the incoming service`);
      }
    }
  }

  // 5. disk: the bundle arrives as a file, is unpacked, then extracted ----
  const bytes = Number(plan?.totals?.bytes || 0);
  const needed = Math.round(bytes * 2.2) + 64 * 1048576;
  const free = await freeBytes(config.projectsRoot);
  const diskOk = free === 0 || free > needed;
  if (!diskOk) {
    blocking.push({
      code: 'disk',
      message: `not enough disk space: ${(needed / 1073741824).toFixed(2)} GB needed, ${(free / 1073741824).toFixed(2)} GB free`,
    });
  }

  // 6. databases: the client tools AND a server actually answering here ---
  const tools = dbtools.toolReport();
  const incoming = (plan?.databases || []).filter((d) => d.included);
  if (options.databases) {
    for (const kind of new Set(incoming.map((d) => d.kind))) {
      const names = incoming.filter((d) => d.kind === kind).map((d) => d.name).join(', ');
      if (!tools[kind]) {
        blocking.push({
          code: 'db-tool',
          message: `this server has no ${kind} client (${dbtools.toolsFor(kind).restore}) — install it, or untick Databases and move ${names} by hand`,
        });
        continue;
      }
      if ((await dbtools.serverReachable(kind)) === false) {
        blocking.push({
          code: 'db-server',
          message: `no ${kind} server is answering on this machine, so ${names} cannot be restored — start one first, or untick Databases`,
        });
      }
    }
  } else {
    // The mistake that actually bites: the move leaves the database behind
    // and the app arrives with nothing to read.
    for (const db of (plan?.databases || []).filter((d) => d.local)) {
      warnings.push(
        `${db.name} (${db.kind}) is NOT coming along — Databases is off, so whatever reads it will start here against a missing database`
      );
    }
  }

  // 7. what only the operator can finish, outside the panel --------------
  if (plan?.source?.projectsRoot && plan.source.projectsRoot !== config.projectsRoot) {
    notes.push(`the other server keeps projects in ${plan.source.projectsRoot}, this one in ${config.projectsRoot} — absolute paths inside .env may need a look`);
  }
  if (options.deploy && services.some((s) => s.sourceType === 'github')) {
    notes.push('this server fetches each git repo itself on deploy — it needs access to them (a token in the clone URL, or a deploy key)');
  }
  if (services.some((s) => s.autoDeploy)) {
    notes.push('auto-deploy is on: repoint the GitHub webhook of those repos at this panel (Settings shows the URL)');
  }
  if (options.databases && (plan?.databases || []).some((d) => d.local)) {
    notes.push('the databases stay on the old server too — drop them there yourself once you trust the move');
  }
  if (options.domains && domains.length) {
    notes.push('HTTPS can only be issued once each domain\'s DNS points at this server — until then its vhost serves plain HTTP and the Domains tab offers Repair');
  }

  return {
    ok: blocking.length === 0,
    server: localInfo(),
    target: { name, slug, path: targetPath },
    blocking,
    warnings: [...new Set(warnings)],
    notes: [...new Set(notes)],
    ports,
    domains,
    disk: { free, needed, ok: diskOk },
    tools,
  };
}

/* ------------------------------------------------------------------ apply */

/** Keep an explicit PORT line in the restored .env in step with a remap. */
function rewriteEnvPort(service, port) {
  const file = envFile.envFileFor(service);
  if (!file || !fs.existsSync(file)) return false;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!/^\s*(export\s+)?PORT\s*=/m.test(text)) return false;
  try {
    fs.writeFileSync(file, text.replace(/^(\s*(?:export\s+)?PORT\s*=).*$/m, `$1${port}`));
    return true;
  } catch {
    return false;
  }
}

/** Run the normal deploy pipeline and wait for it to finish. */
async function deployAndWait(service, log) {
  const deployment = startDeployment(service, { trigger: 'import' });
  const deadline = Date.now() + 45 * 60_000;
  let row = deployment;
  while (Date.now() < deadline) {
    await sleep(1500);
    row = store.getDeployment(deployment.id) || row;
    if (['success', 'failed', 'crashed', 'removed'].includes(row.status)) break;
  }
  if (row.status !== 'success') {
    // Raw build output stays plain log: the findings list is for what the
    // panel itself concluded, not for a tail of someone's npm script.
    for (const l of (row.logs || []).filter((x) => x.stream === 'stderr').slice(-6)) log(`    ${l.line}`);
  }
  return row;
}

/**
 * Unpack a bundle and make the project live on this server.
 * `report` is the transfer job: { log(line, level), step(key, label) -> end(status, detail) }.
 */
export async function applyBundle({ file, dir, options: optionsInput = {}, report = {} }) {
  const log = report.log || noop;
  const step = report.step || (() => () => {});
  const warnings = [];
  const notes = [];
  const warn = (text) => {
    warnings.push(text);
    log(`! ${text}`, 'warn');
  };
  const note = (text) => {
    notes.push(text);
    log(text, 'note');
  };

  /* 1. read the bundle --------------------------------------------------- */
  let bundleDir = dir;
  let manifest;
  const endUnpack = step('unpack', 'Read the bundle');
  try {
    if (bundleDir) {
      manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
    } else {
      bundleDir = `${file}.d`;
      manifest = await unpackBundle(file, bundleDir);
    }
  } catch (e) {
    endUnpack('fail', e.message);
    throw e;
  }
  const options = normalizeOptions({ ...manifest.options, ...optionsInput });
  endUnpack(
    'ok',
    `${manifest.project.name} · ${manifest.services.length} service(s) from ${manifest.source?.hostname || 'the other server'}`
  );

  /* 2. check this server against the real bundle ------------------------- */
  const plan = planFromManifest(manifest);
  const pre = await preflight(plan, options);
  const endCheck = step('ready', 'Make room for the project');
  if (!pre.ok) {
    const why = pre.blocking.map((b) => b.message).join(' · ');
    endCheck('fail', why);
    throw new Error(why);
  }
  endCheck('ok', `${pre.target.path} is free`);
  for (const w of pre.warnings) warn(w);
  for (const n of pre.notes) note(n);

  const targetPath = pre.target.path;
  const remap = new Map(pre.ports.map((p) => [p.slug, p]));

  /* 3. register the project --------------------------------------------- */
  const endRegister = step('register', 'Register the project');
  let created;
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    created = store.importProject({
      project: { ...manifest.project, name: pre.target.name, path: targetPath },
      services: manifest.services.map((s) => {
        const moved = remap.get(s.slug);
        const port = moved ? moved.to : s.port;
        const variables = { ...(s.variables || {}) };
        if (moved && variables.PORT) variables.PORT = String(port);
        return {
          ...s,
          port,
          variables,
          // Domains left out of the move must not be claimed here either:
          // a service row holding a host it does not serve would show a
          // phantom domain in its tab — and deleting that service later
          // would tear down the vhost and certificate of whoever DOES
          // serve it.
          domains: options.domains ? s.domains || [] : [],
          localPath: path.resolve(targetPath, s.relPath || store.slugify(s.name)),
        };
      }),
      deployments: options.history ? manifest.services.flatMap((s) => s.deployments || []) : [],
    });
    endRegister('ok', `${created.services.length} service(s) registered`);
  } catch (e) {
    endRegister('fail', e.message);
    throw e;
  }
  for (const moved of remap.values()) {
    warn(`${moved.service}: port ${moved.from} is taken here (${moved.by}) — the service now runs on ${moved.to}`);
  }

  const entries = manifest.services.map((entry, i) => ({ entry, service: created.services[i] }));

  // From here on, anything that throws must leave NOTHING behind: the
  // original project on the other server is still intact and must stay the
  // only copy.
  try {
    /* 4. files ----------------------------------------------------------- */
    const endFiles = step('files', 'Restore files');
    try {
      let restored = 0;
      let empty = 0;
      for (const { entry, service } of entries) {
        if (!entry.archive) {
          empty += 1;
          fs.mkdirSync(service.localPath, { recursive: true });
          log(`  ${entry.name}: no files to restore (never deployed there)`);
          continue;
        }
        log(`  ${entry.name} → ${service.localPath} (${formatSize(entry.bytes)})`);
        await extractService(bundleDir, entry, service.localPath);
        restored += 1;
        if (remap.has(entry.slug) && rewriteEnvPort(service, service.port)) {
          log(`    .env PORT rewritten to ${service.port}`);
        }
      }
      endFiles('ok', `${restored} folder(s) restored${empty ? `, ${empty} empty` : ''}`);
    } catch (e) {
      endFiles('fail', e.message);
      throw e;
    }

    /* 5. databases ------------------------------------------------------- */
    const dbs = options.databases ? manifest.databases || [] : [];
    if (dbs.length) {
      const endDbs = step('databases', 'Restore databases');
      let ok = 0;
      for (const db of dbs) {
        const dumpFile = path.join(bundleDir, db.file);
        log(`  ${db.kind} ${db.name} (${formatSize(db.bytes)})…`);
        if (!fs.existsSync(dumpFile)) {
          warn(`${db.kind} ${db.name}: its dump is missing from the bundle`);
          continue;
        }
        const res = await dbtools.restoreDatabase({ ...db, host: '127.0.0.1' }, dumpFile, bundleDir);
        if (res.ok) {
          ok += 1;
          log(`    restored${res.via ? ` (via ${res.via})` : ''}`);
        } else {
          warn(`${db.kind} ${db.name}: ${res.output || 'restore failed'}`);
        }
      }
      endDbs(ok === dbs.length ? 'ok' : ok ? 'warn' : 'fail', `${ok}/${dbs.length} restored`);
      if (!ok) throw new Error('not a single database could be restored here');
    } else if ((manifest.databases || []).length) {
      step('databases', 'Restore databases')('skipped', 'databases were left out of this move');
    }

    /* 6. build & start --------------------------------------------------- */
    const deployed = [];
    let deployOk = true;
    if (options.deploy) {
      const endDeploy = step('deploy', 'Build & start');
      for (const { entry, service } of entries) {
        if (!entry.archive && entry.sourceType !== 'github') {
          log(`  ${entry.name}: nothing to run yet — skipped`);
          continue;
        }
        log(`  ${entry.name}: deploying…`);
        const row = await deployAndWait(store.getService(service.id), log);
        deployed.push({ service: entry.name, serviceId: service.id, deploymentId: row.id, status: row.status });
        if (row.status === 'success') {
          log(`  ${entry.name}: running ✓`);
        } else {
          deployOk = false;
          warn(`${entry.name}: its deploy ended as "${row.status}" — the Deployments tab has the full log`);
        }
      }
      endDeploy(
        deployOk ? 'ok' : 'warn',
        `${deployed.filter((d) => d.status === 'success').length}/${deployed.length} service(s) running`
      );
    } else {
      step('deploy', 'Build & start')('skipped', 'deploy on arrival was turned off');
    }

    /* 7. domains --------------------------------------------------------- */
    const domainResults = [];
    const hostCount = entries.reduce((n, { entry }) => n + (entry.domains || []).length, 0);
    if (options.domains && hostCount) {
      const endDomains = step('domains', 'Attach domains');
      for (const { entry, service } of entries) {
        for (const d of entry.domains || []) {
          const live = store.getService(service.id);
          let siteOpts;
          let stored;
          if ((live.serviceKind || 'auto') === 'static' || (d.root && !d.port)) {
            // The source's absolute root means nothing here — recompute it.
            const workdir = envFile.serviceWorkdir(live) || live.localPath;
            const rootPath = path.resolve(workdir || '/', live.staticOutputDir || '');
            if (!fs.existsSync(path.join(rootPath, 'index.html'))) {
              warn(`${d.host}: no build output at ${rootPath} — deploy ${entry.name}, then press Repair in its Domains tab`);
              domainResults.push({ host: d.host, ok: false, https: false });
              continue;
            }
            siteOpts = { domain: d.host, rootPath };
            stored = { host: d.host, https: Boolean(d.https), root: rootPath };
          } else {
            const port = Number(live.port || d.port);
            if (!port) {
              warn(`${d.host}: ${entry.name} has no port here — set one in Settings, then press Repair`);
              domainResults.push({ host: d.host, ok: false, https: false });
              continue;
            }
            siteOpts = { domain: d.host, port };
            stored = { host: d.host, https: Boolean(d.https), port };
          }

          const site = await nginx.createSite(siteOpts);
          if (!site.ok) {
            warn(`${d.host}: nginx ${site.step} failed — ${String(site.output || '').trim().split('\n').slice(-2).join(' · ')}`);
            domainResults.push({ host: d.host, ok: false, https: false });
            continue;
          }
          log(`  ${d.host} → ${siteOpts.rootPath || `127.0.0.1:${siteOpts.port}`}`);

          let httpsOk = false;
          if (d.https) {
            const res = await nginx.enableHttps({ domain: d.host });
            httpsOk = res.ok;
            if (res.ok) log(`    HTTPS ${res.reusedCert ? 'installed from the existing certificate' : 'issued'} ✓`);
            // Not a warning: until the DNS points here no ACME challenge can
            // succeed, so this is the expected state of every move.
            else note(`${d.host}: still HTTP only — point its DNS at this server, then press Repair in its Domains tab`);
          }
          // https stays the stored WISH even when certbot could not run yet,
          // so Repair can finish the job later — same as a hand-added domain.
          store.updateService(service.id, {
            domains: [...(store.getService(service.id).domains || []).filter((x) => x.host !== d.host), stored],
          });
          domainResults.push({ host: d.host, ok: true, https: httpsOk });
        }
      }
      const good = domainResults.filter((d) => d.ok).length;
      endDomains(good === domainResults.length ? 'ok' : good ? 'warn' : 'fail', `${good}/${domainResults.length} domain(s) configured`);
    } else if (hostCount) {
      step('domains', 'Attach domains')(
        'skipped',
        `domains were left out — ${hostCount} host(s) stay with the original, attach new ones here when you want`
      );
    }

    return {
      ok: deployOk,
      projectId: created.project.id,
      projectName: created.project.name,
      path: targetPath,
      services: created.services.map((s) => ({ id: s.id, name: s.name, port: s.port, pm2Name: s.pm2Name })),
      deployed,
      domains: domainResults,
      databases: dbs.map((d) => ({ kind: d.kind, name: d.name })),
      warnings,
      notes,
      server: localInfo(),
    };
  } catch (err) {
    // Roll back so this server is left as it was and the operator has only
    // one copy of the project to think about: the untouched original.
    const endRollback = step('rollback', 'Undo the half-import');
    try {
      const fresh = store.getProject(created.project.id);
      if (fresh) await deleteProjectCompletely(fresh);
      endRollback('ok', `removed ${pre.target.name} from this server — the original is untouched`);
    } catch (e) {
      endRollback('warn', `could not fully undo: ${e.message} — check ${targetPath}`);
    }
    throw err;
  }
}

/* ------------------------------------------------------ source-side moves */

/** Hold still while being copied: stop the project's pm2 processes. */
export async function quiesceProject(projectId) {
  const project = store.getProject(projectId);
  if (!project) throw new Error('Project not found');
  const results = await bulkPm2(project, 'stop');
  return { ok: results.every((r) => r.ok), results };
}

/** Undo a quiesce — used when a transfer fails and the original must live on. */
export async function resumeProject(projectId) {
  const project = store.getProject(projectId);
  if (!project) throw new Error('Project not found');
  const results = await bulkPm2(project, 'start');
  return { ok: results.every((r) => r.ok), results };
}

/**
 * The project is live on the other server: stand down here. Processes,
 * domains (nginx vhost + certificate), folders and db rows all go.
 */
export async function releaseProject(projectId, optionsInput = {}) {
  const options = normalizeOptions(optionsInput);
  const project = store.getProject(projectId);
  if (!project) return { ok: true, already: true };
  if (!options.removeSource) return { ok: true, kept: true, name: project.name };
  const { cleanup, folder } = await deleteProjectCompletely(project);
  return { ok: true, cleanup, folder, name: project.name };
}
