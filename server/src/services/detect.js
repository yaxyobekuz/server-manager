import fs from 'node:fs';
import path from 'node:path';

/**
 * Inspect a checked-out project and infer how to deploy it.
 *
 * kind 'static'  — build produces files served by nginx directly (no pm2):
 *                  React/Vite/CRA/Angular SPAs, plain html.
 * kind 'backend' — a long-running process managed by pm2: Express, Next.js,
 *                  bots, anything with a start script.
 *
 * Returns { kind, buildCommand, startCommand, outputDir, reason }.
 * Empty strings mean "nothing to do for this step".
 */
export function detectProject(workdir) {
  const pkgPath = path.join(workdir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    if (fs.existsSync(path.join(workdir, 'index.html'))) {
      return { kind: 'static', buildCommand: '', startCommand: '', outputDir: '', reason: 'plain static site (index.html, no package.json)' };
    }
    return { kind: 'backend', buildCommand: '', startCommand: '', outputDir: '', reason: 'no package.json — set commands manually in Settings' };
  }

  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    /* malformed package.json — fall through with empty deps */
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const buildInstall = scripts.build ? 'npm install && npm run build' : 'npm install';

  // Frameworks that need a node server even though they have a build step.
  if (deps.next) {
    return { kind: 'backend', buildCommand: buildInstall, startCommand: scripts.start ? 'npm start' : 'npx next start', outputDir: '', reason: 'Next.js app' };
  }

  // SPA toolchains -> static output served by nginx.
  if (deps['react-scripts']) {
    return { kind: 'static', buildCommand: buildInstall, startCommand: '', outputDir: 'build', reason: 'Create React App' };
  }
  if (deps.vite) {
    return { kind: 'static', buildCommand: buildInstall, startCommand: '', outputDir: 'dist', reason: 'Vite app' };
  }
  if (deps['@angular/core']) {
    return { kind: 'static', buildCommand: buildInstall, startCommand: '', outputDir: 'dist', reason: 'Angular app (check output dir — may be dist/<name>/browser)' };
  }

  // A start script (and no SPA toolchain) -> long-running node backend.
  if (scripts.start || pkg.main) {
    return { kind: 'backend', buildCommand: buildInstall, startCommand: scripts.start ? 'npm start' : `node ${pkg.main}`, outputDir: '', reason: 'node backend (start script)' };
  }

  // Build script only -> assume it emits a static site.
  if (scripts.build) {
    return { kind: 'static', buildCommand: buildInstall, startCommand: '', outputDir: 'dist', reason: 'build script only — assuming static output' };
  }

  return { kind: 'backend', buildCommand: 'npm install', startCommand: '', outputDir: '', reason: 'could not detect — set commands manually in Settings' };
}
