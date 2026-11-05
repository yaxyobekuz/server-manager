import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { run } from './exec.js';

/**
 * Databases that belong to a service, found by reading its .env — the same
 * place the app itself reads them from. Only databases living ON THIS MACHINE
 * are dumped and restored during a transfer: a managed/remote database
 * (Atlas, RDS, another VPS) keeps working from the new server untouched, so
 * copying it would be wrong.
 *
 * Everything here is best-effort and loud: a database the panel cannot dump
 * or restore becomes a reported warning, never a silent omission — the
 * transfer refuses to delete the source until the operator has seen it.
 */

const DEFAULT_PORT = { mysql: 3306, postgres: 5432, mongo: 27017 };
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', os.hostname()]);

export const isLocalHost = (host) => LOCAL_HOSTS.has(String(host || '').trim().toLowerCase());

const KIND_BY_SCHEME = {
  mysql: 'mysql', mysql2: 'mysql', mariadb: 'mysql',
  postgres: 'postgres', postgresql: 'postgres', pgsql: 'postgres', pg: 'postgres',
  mongodb: 'mongo', 'mongodb+srv': 'mongo',
};

const URL_KEYS = [
  'DATABASE_URL', 'DATABASE_URI', 'DB_URL', 'DB_URI', 'DB_CONNECTION_STRING',
  'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_CONNECTION_STRING',
  'MYSQL_URL', 'MARIADB_URL',
  'MONGO_URL', 'MONGO_URI', 'MONGODB_URL', 'MONGODB_URI', 'MONGO_CONNECTION_STRING',
];

const pick = (vars, ...keys) => {
  for (const k of keys) if (vars[k] !== undefined && String(vars[k]).trim() !== '') return String(vars[k]).trim();
  return '';
};

function fromUrl(raw, sourceKey) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  const kind = KIND_BY_SCHEME[u.protocol.replace(':', '').toLowerCase()];
  if (!kind) return null;
  const name = decodeURIComponent(u.pathname.replace(/^\//, '')).split('?')[0];
  if (!name) return null;
  return {
    kind,
    host: u.hostname || 'localhost',
    port: Number(u.port) || DEFAULT_PORT[kind],
    name,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    uri: String(raw).trim(),
    srv: u.protocol.toLowerCase() === 'mongodb+srv:',
    source: sourceKey,
  };
}

function fromDiscrete(vars) {
  const found = [];
  const add = (db) => db?.name && found.push(db);

  // Laravel / generic DB_* block
  const dbName = pick(vars, 'DB_DATABASE', 'DB_NAME');
  if (dbName) {
    const conn = pick(vars, 'DB_CONNECTION', 'DB_DRIVER', 'DB_CLIENT').toLowerCase();
    const port = Number(pick(vars, 'DB_PORT')) || 0;
    const kind =
      KIND_BY_SCHEME[conn] ||
      (/maria|mysql/.test(conn) ? 'mysql' : /pg|postgres/.test(conn) ? 'postgres' : /mongo/.test(conn) ? 'mongo' : null) ||
      (port === 5432 ? 'postgres' : port === 27017 ? 'mongo' : 'mysql');
    add({
      kind,
      host: pick(vars, 'DB_HOST') || 'localhost',
      port: port || DEFAULT_PORT[kind],
      name: dbName,
      user: pick(vars, 'DB_USERNAME', 'DB_USER'),
      password: pick(vars, 'DB_PASSWORD', 'DB_PASS'),
      source: 'DB_DATABASE',
    });
  }

  const mysqlName = pick(vars, 'MYSQL_DATABASE', 'MYSQL_DB');
  if (mysqlName) {
    add({
      kind: 'mysql',
      host: pick(vars, 'MYSQL_HOST') || 'localhost',
      port: Number(pick(vars, 'MYSQL_PORT')) || 3306,
      name: mysqlName,
      user: pick(vars, 'MYSQL_USER', 'MYSQL_USERNAME'),
      password: pick(vars, 'MYSQL_PASSWORD', 'MYSQL_PASS', 'MYSQL_ROOT_PASSWORD'),
      source: 'MYSQL_DATABASE',
    });
  }

  const pgName = pick(vars, 'POSTGRES_DB', 'POSTGRES_DATABASE', 'PGDATABASE');
  if (pgName) {
    add({
      kind: 'postgres',
      host: pick(vars, 'POSTGRES_HOST', 'PGHOST') || 'localhost',
      port: Number(pick(vars, 'POSTGRES_PORT', 'PGPORT')) || 5432,
      name: pgName,
      user: pick(vars, 'POSTGRES_USER', 'PGUSER') || 'postgres',
      password: pick(vars, 'POSTGRES_PASSWORD', 'PGPASSWORD'),
      source: 'POSTGRES_DB',
    });
  }

  const mongoName = pick(vars, 'MONGO_DATABASE', 'MONGO_DB', 'MONGO_DB_NAME', 'MONGODB_DATABASE');
  if (mongoName) {
    add({
      kind: 'mongo',
      host: pick(vars, 'MONGO_HOST', 'MONGODB_HOST') || 'localhost',
      port: Number(pick(vars, 'MONGO_PORT', 'MONGODB_PORT')) || 27017,
      name: mongoName,
      user: pick(vars, 'MONGO_USER', 'MONGO_USERNAME', 'MONGODB_USER'),
      password: pick(vars, 'MONGO_PASSWORD', 'MONGODB_PASSWORD'),
      source: 'MONGO_DATABASE',
    });
  }

  return found;
}

/**
 * Every database referenced by a set of env variables, de-duplicated.
 * `local` says whether it lives on this machine (only those get dumped).
 */
export function detectDatabases(vars = {}) {
  const out = [];
  const seen = new Set();
  const push = (db) => {
    if (!db?.name) return;
    const local = !db.srv && isLocalHost(db.host);
    const key = `${db.kind}:${local ? 'local' : db.host}:${db.port}:${db.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...db, local, key });
  };

  for (const k of URL_KEYS) {
    if (vars[k]) push(fromUrl(vars[k], k));
  }
  for (const db of fromDiscrete(vars)) push(db);
  return out;
}

/** Cache-only stores we deliberately never copy (they rebuild themselves). */
export function detectCaches(vars = {}) {
  const hits = [];
  for (const k of ['REDIS_URL', 'REDIS_HOST', 'MEMCACHED_URL', 'MEMCACHED_HOST']) {
    if (vars[k]) hits.push(k);
  }
  return hits;
}

/* ------------------------------------------------------------------ tools */

// tiny synchronous `which` — no dependency, no shell
function whichSync(bin) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export function toolsFor(kind) {
  if (kind === 'mysql') return { dump: 'mysqldump', restore: 'mysql' };
  if (kind === 'postgres') return { dump: 'pg_dump', restore: 'psql' };
  if (kind === 'mongo') return { dump: 'mongodump', restore: 'mongorestore' };
  return { dump: '', restore: '' };
}

/** Which database clients this machine actually has. */
export function toolReport() {
  const has = (bin) => Boolean(whichSync(bin));
  return {
    mysql: has('mysqldump') && has('mysql'),
    postgres: has('pg_dump') && has('psql'),
    mongo: has('mongodump') && has('mongorestore'),
  };
}

export const describeDb = (db) => `${db.kind} ${db.name}${db.local ? '' : ` @ ${db.host}`}`;

/* -------------------------------------------------------------- utilities */

function childToGzip(cmd, args, opts, outFile) {
  return new Promise((resolve) => {
    let stderr = '';
    let code = null;
    let written = false;
    const settle = () => {
      if (code !== null && written) resolve({ code, stderr: stderr.trim() });
    };
    let child;
    try {
      child = spawn(cmd, args, { env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stderr: e.message });
    }
    const out = fs.createWriteStream(outFile);
    child.stdout.pipe(zlib.createGzip({ level: 6 })).pipe(out);
    child.stderr.on('data', (d) => {
      if (stderr.length < 8000) stderr += d.toString();
    });
    child.on('error', (e) => {
      stderr += e.message;
      code = -1;
      out.destroy();
      written = true;
      settle();
    });
    child.on('close', (c) => {
      code = c ?? -1;
      settle();
    });
    out.on('finish', () => {
      written = true;
      settle();
    });
    out.on('error', (e) => {
      stderr += `\n${e.message}`;
      written = true;
      settle();
    });
  });
}

function gzipToChild(file, cmd, args, opts) {
  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let child;
    try {
      child = spawn(cmd, args, { env: opts.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stderr: e.message, stdout: '' });
    }
    child.stderr.on('data', (d) => {
      if (stderr.length < 8000) stderr += d.toString();
    });
    child.stdout.on('data', (d) => {
      if (stdout.length < 8000) stdout += d.toString();
    });
    child.stdin.on('error', () => {
      /* the client died early — its stderr carries the real reason */
    });
    fs.createReadStream(file).pipe(zlib.createGunzip()).pipe(child.stdin);
    child.on('error', (e) => resolve({ code: -1, stderr: stderr + e.message, stdout }));
    child.on('close', (c) => resolve({ code: c ?? -1, stderr: stderr.trim(), stdout: stdout.trim() }));
  });
}

const tail = (text, n = 6) =>
  String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^Warning: Using a password/i.test(l))
    .slice(-n)
    .join(' · ');

/** Temp my.cnf so a password never appears in the process list. */
function mysqlDefaults(db, dir) {
  const file = path.join(dir, `my-${db.name.replace(/[^\w.-]/g, '')}.cnf`);
  const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  fs.writeFileSync(
    file,
    `[client]\nhost="${esc(db.host || 'localhost')}"\nport=${Number(db.port) || 3306}\n` +
      (db.user ? `user="${esc(db.user)}"\n` : '') +
      (db.password ? `password="${esc(db.password)}"\n` : ''),
    { mode: 0o600 }
  );
  return file;
}

const SAFE_NAME = /^[A-Za-z0-9_$][A-Za-z0-9_$-]*$/;
const mongoUri = (db) =>
  db.uri ||
  `mongodb://${db.user ? `${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}@` : ''}${db.host || '127.0.0.1'}:${db.port || 27017}/${db.name}`;

/* ------------------------------------------------------------------ dumps */

/** Dump one database into `outFile` (always gzipped). */
export async function dumpDatabase(db, outFile, tmpDir) {
  if (!SAFE_NAME.test(db.name)) {
    return { ok: false, output: `database name "${db.name}" has characters the panel will not pass to a shell tool` };
  }
  const { dump } = toolsFor(db.kind);
  if (!whichSync(dump)) {
    return { ok: false, output: `${dump} is not installed on this server — install it or untick databases` };
  }

  if (db.kind === 'mysql') {
    const cnf = mysqlDefaults(db, tmpDir);
    const r = await childToGzip(
      'mysqldump',
      [`--defaults-file=${cnf}`, '--single-transaction', '--quick', '--routines', '--triggers',
       '--no-tablespaces', '--set-gtid-purged=OFF', '--databases', db.name],
      {}, outFile
    );
    fs.rmSync(cnf, { force: true });
    // --set-gtid-purged is MySQL-only; MariaDB rejects it, so retry without.
    if (r.code !== 0 && /set-gtid-purged|unknown option/i.test(r.stderr)) {
      const cnf2 = mysqlDefaults(db, tmpDir);
      const r2 = await childToGzip(
        'mysqldump',
        [`--defaults-file=${cnf2}`, '--single-transaction', '--quick', '--routines', '--triggers',
         '--no-tablespaces', '--databases', db.name],
        {}, outFile
      );
      fs.rmSync(cnf2, { force: true });
      return { ok: r2.code === 0, output: tail(r2.stderr) };
    }
    return { ok: r.code === 0, output: tail(r.stderr) };
  }

  if (db.kind === 'postgres') {
    const r = await childToGzip(
      'pg_dump',
      ['-h', db.host || 'localhost', '-p', String(db.port || 5432), '-U', db.user || 'postgres',
       '--no-owner', '--no-privileges', '--clean', '--if-exists', '-d', db.name],
      { env: { ...process.env, PGPASSWORD: db.password || '', PGCONNECT_TIMEOUT: '10' } },
      outFile
    );
    return { ok: r.code === 0, output: tail(r.stderr) };
  }

  if (db.kind === 'mongo') {
    // mongodump writes the archive itself (already gzipped with --gzip).
    const r = await run('mongodump', [`--uri=${mongoUri(db)}`, `--archive=${outFile}`, '--gzip'], { timeout: 1800_000 });
    return { ok: r.code === 0, output: tail(r.stderr || r.stdout) };
  }

  return { ok: false, output: `unsupported database type ${db.kind}` };
}

/* --------------------------------------------------------------- restores */

async function ensureMysql(db, tmpDir) {
  const ident = `\`${db.name.replace(/`/g, '``')}\``;
  const sq = (v) => `'${String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const statements = [`CREATE DATABASE IF NOT EXISTS ${ident} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`];
  if (db.user && db.user !== 'root') {
    statements.push(
      `CREATE USER IF NOT EXISTS ${sq(db.user)}@'localhost' IDENTIFIED BY ${sq(db.password)};`,
      `CREATE USER IF NOT EXISTS ${sq(db.user)}@'%' IDENTIFIED BY ${sq(db.password)};`,
      `GRANT ALL PRIVILEGES ON ${ident}.* TO ${sq(db.user)}@'localhost';`,
      `GRANT ALL PRIVILEGES ON ${ident}.* TO ${sq(db.user)}@'%';`,
      'FLUSH PRIVILEGES;'
    );
  }
  const sql = statements.join('\n');
  // Prefer the local root socket (the panel runs as root); fall back to the
  // app's own credentials, which is enough when the database already exists.
  const asRoot = await run('mysql', ['--protocol=socket', '-uroot', '-e', sql], { timeout: 60000 });
  if (asRoot.code === 0) return { ok: true, via: 'root socket' };
  const cnf = mysqlDefaults(db, tmpDir);
  const asApp = await run('mysql', [`--defaults-file=${cnf}`, '-e', sql], { timeout: 60000 });
  fs.rmSync(cnf, { force: true });
  if (asApp.code === 0) return { ok: true, via: db.user || 'app user' };
  return { ok: false, output: tail(asRoot.stderr || asRoot.stdout) || tail(asApp.stderr || asApp.stdout) };
}

async function ensurePostgres(db) {
  const sq = (v) => `'${String(v ?? '').replace(/'/g, "''")}'`;
  const ident = `"${db.name.replace(/"/g, '""')}"`;
  const role = `"${String(db.user || 'postgres').replace(/"/g, '""')}"`;
  const probe = await run('sudo', ['-n', '-u', 'postgres', 'psql', '-tAc', 'select 1'], { timeout: 30000 });
  if (probe.code !== 0) {
    return { ok: false, output: 'cannot reach PostgreSQL as the postgres superuser — create the role/database by hand, then run the transfer again' };
  }
  const steps = [];
  if (db.user && db.user !== 'postgres') {
    steps.push(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sq(db.user)}) THEN CREATE ROLE ${role} LOGIN PASSWORD ${sq(db.password)}; ELSE ALTER ROLE ${role} LOGIN PASSWORD ${sq(db.password)}; END IF; END $$;`
    );
  }
  for (const sql of steps) {
    const r = await run('sudo', ['-n', '-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-c', sql], { timeout: 60000 });
    if (r.code !== 0) return { ok: false, output: tail(r.stderr || r.stdout) };
  }
  const create = await run(
    'sudo',
    ['-n', '-u', 'postgres', 'psql', '-c', `CREATE DATABASE ${ident} OWNER ${role};`],
    { timeout: 120000 }
  );
  if (create.code !== 0 && !/already exists/i.test(create.stderr + create.stdout)) {
    return { ok: false, output: tail(create.stderr || create.stdout) };
  }
  return { ok: true, via: 'postgres superuser' };
}

/** Create the database (and its user) if needed, then load the dump. */
export async function restoreDatabase(db, file, tmpDir) {
  if (!SAFE_NAME.test(db.name)) {
    return { ok: false, output: `database name "${db.name}" has characters the panel will not pass to a shell tool` };
  }
  const { restore } = toolsFor(db.kind);
  if (!whichSync(restore)) {
    return { ok: false, output: `${restore} is not installed on this server — install it and import the dump by hand` };
  }

  if (db.kind === 'mysql') {
    const ready = await ensureMysql(db, tmpDir);
    if (!ready.ok) return { ok: false, output: `could not create the database/user: ${ready.output}` };
    const cnf = mysqlDefaults(db, tmpDir);
    const r = await gzipToChild(file, 'mysql', [`--defaults-file=${cnf}`, db.name], {});
    fs.rmSync(cnf, { force: true });
    return { ok: r.code === 0, output: tail(r.stderr), via: ready.via };
  }

  if (db.kind === 'postgres') {
    const ready = await ensurePostgres(db);
    if (!ready.ok) return { ok: false, output: `could not create the database/role: ${ready.output}` };
    const r = await gzipToChild(file, 'psql', [
      '-h', db.host || 'localhost', '-p', String(db.port || 5432), '-U', db.user || 'postgres',
      '-d', db.name, '-v', 'ON_ERROR_STOP=0', '--quiet',
    ], { env: { ...process.env, PGPASSWORD: db.password || '', PGCONNECT_TIMEOUT: '10' } });
    // psql exits 0 with non-fatal NOTICEs; real failures show up as ERROR.
    const errors = String(r.stderr || '').split('\n').filter((l) => /^ERROR/.test(l.trim()));
    return { ok: r.code === 0, output: tail(errors.join('\n')) || (errors.length ? `${errors.length} statement error(s)` : ''), via: ready.via };
  }

  if (db.kind === 'mongo') {
    const r = await run(
      'mongorestore',
      [`--uri=${mongoUri(db)}`, `--archive=${file}`, '--gzip', '--drop'],
      { timeout: 1800_000 }
    );
    return { ok: r.code === 0, output: tail(r.stderr || r.stdout) };
  }

  return { ok: false, output: `unsupported database type ${db.kind}` };
}
