import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';

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

/** Write the config, symlink it into sites-enabled, test, then reload. */
export async function createSite({ domain, port, config: rawConfig }) {
  const name = path.basename(domain); // file named after the domain
  const available = path.join(SITES_AVAILABLE, name);
  const enabled = path.join(SITES_ENABLED, name);

  const content = rawConfig || buildConfig({ domain, port });
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
 * Issue/renew an HTTPS certificate with certbot's nginx plugin.
 * Certbot edits the matching nginx server block in place to add SSL.
 */
export async function enableHttps({ domain, email }) {
  const args = [
    '--nginx',
    '-d',
    domain,
    '--non-interactive',
    '--agree-tos',
    '--redirect',
  ];
  if (email) args.push('-m', email);
  else args.push('--register-unsafely-without-email');

  const result = await run('certbot', args, { timeout: 120000 });
  return {
    ok: result.code === 0,
    output: result.stdout + '\n' + result.stderr,
  };
}
