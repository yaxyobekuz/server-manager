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
