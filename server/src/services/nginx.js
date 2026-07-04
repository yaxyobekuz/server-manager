import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';
const LOG_FORMAT_CONF = '/etc/nginx/conf.d/server-manager-logfmt.conf';

/**
 * Per-domain access logs power the traffic metrics (traffic.js). Files live
 * directly in /var/log/nginx so the stock logrotate config rotates them.
 */
export function logPathFor(domain) {
  return `/var/log/nginx/sm-${path.basename(domain)}.access.log`;
}

const accessLogLine = (domain) => `    access_log ${logPathFor(domain)} sm_metrics;`;

/** The custom log format must exist (http context) before any site uses it. */
export function ensureLogFormat() {
  const content =
    "# Managed by server-manager — parsed by its traffic metrics collector\n" +
    "log_format sm_metrics '$time_iso8601|$host|$status|$body_bytes_sent|$request_time|$request';\n";
  try {
    if (!fs.existsSync(LOG_FORMAT_CONF) || fs.readFileSync(LOG_FORMAT_CONF, 'utf8') !== content) {
      fs.writeFileSync(LOG_FORMAT_CONF, content);
    }
  } catch {
    /* sites still work with the default log — metrics just stay empty */
  }
}

/**
 * Generate a reverse-proxy server block that forwards a domain to a local
 * port (e.g. one of the PM2 apps). HTTPS is added later by certbot, which
 * rewrites this file in place.
 */
export function buildConfig({ domain, port }) {
  return `# Managed by server-manager
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

${accessLogLine(domain)}

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
}

export function listSites() {
  if (!fs.existsSync(SITES_AVAILABLE)) return [];
  return fs.readdirSync(SITES_AVAILABLE).map((name) => ({
    name,
    enabled: fs.existsSync(path.join(SITES_ENABLED, name)),
  }));
}

export function readSite(name) {
  const p = path.join(SITES_AVAILABLE, path.basename(name));
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * Server block for a static build (React/Vite/CRA): nginx serves the files
 * itself — no proxy, no pm2. SPA routes fall back to index.html.
 */
export function buildStaticConfig({ domain, rootPath }) {
  return `# Managed by server-manager
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

${accessLogLine(domain)}

    root ${rootPath};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
}

/** Write the config, symlink it into sites-enabled, test, then reload. */
export async function createSite({ domain, port, rootPath, config: rawConfig }) {
  const name = path.basename(domain); // file named after the domain
  const available = path.join(SITES_AVAILABLE, name);
  const enabled = path.join(SITES_ENABLED, name);

  ensureLogFormat(); // sm_metrics must be defined before a site references it

  const content =
    rawConfig || (rootPath ? buildStaticConfig({ domain, rootPath }) : buildConfig({ domain, port }));
  fs.writeFileSync(available, content);

  if (!fs.existsSync(enabled)) {
    fs.symlinkSync(available, enabled);
  }

  const test = await run('nginx', ['-t']);
  if (test.code !== 0) {
    return { ok: false, step: 'nginx -t', output: test.stderr || test.stdout };
  }

  const reload = await run('systemctl', ['reload', 'nginx']);
  if (reload.code !== 0) {
    return { ok: false, step: 'reload', output: reload.stderr || reload.stdout };
  }
  return { ok: true };
}

export async function deleteSite(name) {
  const safe = path.basename(name);
  const available = path.join(SITES_AVAILABLE, safe);
  const enabled = path.join(SITES_ENABLED, safe);
  if (fs.existsSync(enabled)) fs.unlinkSync(enabled);
  if (fs.existsSync(available)) fs.unlinkSync(available);
  await run('systemctl', ['reload', 'nginx']);
  return { ok: true };
}

/**
 * True when the domain's nginx config actually terminates TLS. The store's
 * `https` flag is what the user asked for; this is what nginx really has —
 * a failed certbot run (network error, rate limit) leaves the two apart.
 */
export function sslConfigured(domain) {
  const conf = readSite(domain);
  return Boolean(conf && /listen\s+(\[::\]:)?443\s+ssl/.test(conf) && conf.includes('ssl_certificate'));
}

/** What nginx actually has for a domain, regardless of what the store says. */
export function siteStatus(domain) {
  const name = path.basename(domain);
  return {
    confExists: fs.existsSync(path.join(SITES_AVAILABLE, name)),
    enabled: fs.existsSync(path.join(SITES_ENABLED, name)),
    ssl: sslConfigured(domain),
  };
}

/** Remove a domain's Let's Encrypt certificate (no-op if it never existed). */
export async function deleteHttps(domain) {
  const result = await run('certbot', ['delete', '--cert-name', domain, '--non-interactive'], {
    timeout: 60000,
  });
  return { ok: result.code === 0, output: result.stdout + '\n' + result.stderr };
}

/**
 * Put HTTPS on the domain's server block. A valid certificate often already
 * sits in /etc/letsencrypt (domain re-attached after the folder or service
 * was recreated) — installing it is instant and offline, while
 * `certbot --nginx -d …` goes back to the ACME API and can die on a
 * transient network error without ever touching the config.
 */
export async function enableHttps({ domain, email }) {
  const certName = path.basename(domain);
  if (fs.existsSync(`/etc/letsencrypt/live/${certName}/fullchain.pem`)) {
    const inst = await run(
      'certbot',
      ['install', '--nginx', '--cert-name', certName, '--redirect', '--non-interactive'],
      { timeout: 120000 },
    );
    if (inst.code === 0 && sslConfigured(domain)) {
      return { ok: true, reusedCert: true, output: inst.stdout + '\n' + inst.stderr };
    }
    // fall through — a fresh issue can still succeed where install failed
  }

  const args = ['--nginx', '-d', domain, '--non-interactive', '--agree-tos', '--redirect'];
  if (email) args.push('-m', email);
  else args.push('--register-unsafely-without-email');

  const result = await run('certbot', args, { timeout: 120000 });
  return {
    // certbot can exit 0 without editing the config ("not yet due for
    // renewal") — only a 443 block in the config counts as success.
    ok: result.code === 0 && sslConfigured(domain),
    output: result.stdout + '\n' + result.stderr,
  };
}
