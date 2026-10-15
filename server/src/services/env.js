import fs from 'node:fs';
import path from 'node:path';

/**
 * Read / write a project's .env file as raw text. We keep it as plain text
 * (not parsed key/value) so comments and ordering survive edits.
 */

function envPath(projectPath, file = '.env') {
  // Guard against path traversal in the file name.
  const safe = path.basename(file);
  return path.join(projectPath, safe);
}

export function readEnv(projectPath, file = '.env') {
  const p = envPath(projectPath, file);
  if (!fs.existsSync(p)) return { exists: false, content: '' };
  return { exists: true, content: fs.readFileSync(p, 'utf8') };
}

export function writeEnv(projectPath, content, file = '.env') {
  const p = envPath(projectPath, file);
  fs.writeFileSync(p, content, 'utf8');
  return { ok: true };
}

/** List candidate env files in a project directory. */
export function listEnvFiles(projectPath) {
  if (!fs.existsSync(projectPath)) return [];
  return fs
    .readdirSync(projectPath)
    .filter((f) => f === '.env' || f.startsWith('.env.'));
}

/* ------------------------------------------------- .env as source of truth
 * Service variables live in the service's .env FILE, not in the panel's db.
 * The db copy is only a bootstrap: it seeds .env on the first deploy of a
 * fresh clone, when no file exists yet.
 */

export function serviceWorkdir(service) {
  if (!service?.localPath) return '';
  return service.rootDirectory
    ? path.join(service.localPath, service.rootDirectory)
    : service.localPath;
}

export function envFileFor(service) {
  const dir = serviceWorkdir(service);
  return dir ? path.join(dir, '.env') : '';
}

/** dotenv-style parse: KEY=VALUE lines, comments skipped, quotes stripped. */
export function parseEnv(content) {
  const vars = {};
  for (const raw of String(content).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().replace(/^export\s+/, '');
    let val = line.slice(i + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.length >= 2 && val.endsWith(q)) val = val.slice(1, -1);
    if (key) vars[key] = val;
  }
  return vars;
}

/** Variables as the app sees them: the .env file when it exists, else the
 *  panel's staged copy (service not deployed yet). */
export function readServiceVariables(service) {
  const file = envFileFor(service);
  if (file && fs.existsSync(file)) {
    try {
      return { variables: parseEnv(fs.readFileSync(file, 'utf8')), source: 'file', path: file };
    } catch {
      /* unreadable — fall through to the staged copy */
    }
  }
  return { variables: service?.variables || {}, source: 'panel', path: file };
}

/**
 * Write variables into the .env file, patch-style: existing lines keep their
 * order, comments and blank lines survive, removed keys are dropped and new
 * keys are appended. Returns ok:false when the service folder doesn't exist
 * yet (caller keeps the staged copy in db until the first deploy).
 */
export function writeServiceVariables(service, variables) {
  const file = envFileFor(service);
  if (!file || !fs.existsSync(path.dirname(file))) return { ok: false, path: file };
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const remaining = new Map(Object.entries(variables || {}));
  const out = [];
  for (const line of existing.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) {
      out.push(line);
      continue;
    }
    const key = t.slice(0, t.indexOf('=')).trim().replace(/^export\s+/, '');
    if (remaining.has(key)) {
      out.push(`${key}=${remaining.get(key)}`);
      remaining.delete(key);
    }
    // key absent from the new set → line dropped
  }
  for (const [k, v] of remaining) out.push(`${k}=${v}`);
  let text = out.join('\n').replace(/\n{3,}$/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  try {
    fs.writeFileSync(file, text);
    return { ok: true, path: file };
  } catch {
    return { ok: false, path: file };
  }
}
