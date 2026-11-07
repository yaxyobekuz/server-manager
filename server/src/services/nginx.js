import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { config } from '../config.js';

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

/**
 * The bits that must exist in the http context before any site uses them:
 * the log format the traffic collector parses, and a map that lets a site
 * pass the ORIGINAL scheme through when a proxy in front terminated TLS
 * (falling back to $scheme when there is no such proxy).
 */
export function ensureLogFormat() {
  const content =
    "# Managed by server-manager — parsed by its traffic metrics collector\n" +
    // $request_method $uri, not $request: $request carries the query string,
    // and a secret handed to the panel in a URL (the MCP endpoint takes the
    // password that way) would otherwise be written to disk in plain text on
    // every call. The collector only ever reads the path.
    "log_format sm_metrics '$time_iso8601|$host|$status|$body_bytes_sent|$request_time|$request_method $uri';\n" +
    // The ordinary combined log, minus the query string, for server blocks
    // that are not generated here (the handoff listener). Same reason as
    // above: a secret passed in a URL must not be written to disk.
    "log_format sm_combined '$remote_addr - $remote_user [$time_local] "
    + '"$request_method $uri $server_protocol" $status $body_bytes_sent '
    + "\"$http_referer\" \"$http_user_agent\"';\n" +
    "\n# The scheme the client really used: the header when a proxy sent one,\n" +
    "# this server's own scheme otherwise.\n" +
    "map $http_x_forwarded_proto $sm_forwarded_proto {\n" +
    "    default $http_x_forwarded_proto;\n" +
    "    ''      $scheme;\n" +
    "}\n";
  try {
    if (!fs.existsSync(LOG_FORMAT_CONF) || fs.readFileSync(LOG_FORMAT_CONF, 'utf8') !== content) {
      fs.writeFileSync(LOG_FORMAT_CONF, content);
    }
  } catch {
    /* sites still work with the default log — metrics just stay empty */
  }
}

/**
 * What the generated blocks listen on. Plain port 80 unless the public
 * ports belong to something else and NGINX_LISTEN names the address that
 * proxy forwards to. `default_server` is never set here: the handoff
 * listener usually already has one, and only one is allowed.
 */
function listenLines() {
  return config.nginx.listen
    ? `    listen ${config.nginx.listen};`
    : '    listen 80;\n    listen [::]:80;';
}

/**
 * With a proxy in front, $remote_addr is the proxy — so the access log, the
 * traffic metrics and the app itself would all see one address for every
 * visitor. These lines restore the real one from X-Forwarded-For.
 */
function realIpLines() {
  if (!config.nginx.trustedProxy) return '';
  return (
    `\n    set_real_ip_from ${config.nginx.trustedProxy};\n` +
    '    real_ip_header X-Forwarded-For;\n' +
    '    real_ip_recursive on;\n'
  );
}

/**
 * Generate a reverse-proxy server block that forwards a domain to a local
 * port (e.g. one of the PM2 apps). HTTPS is added later by certbot, which
 * rewrites this file in place — unless TLS already ended upstream.
 */
export function buildConfig({ domain, port }) {
  return `# Managed by server-manager
server {
${listenLines()}
    server_name ${domain};
${realIpLines()}
${accessLogLine(domain)}

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $sm_forwarded_proto;
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
${listenLines()}
    server_name ${domain};
${realIpLines()}
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
  // With TLS terminated in front of nginx there is no 443 block to find and
  // never will be — but the site IS served over HTTPS, which is what the
  // panel reports.
  if (config.nginx.upstreamTls) return true;
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

/** Put an existing certificate into the domain's server block. */
async function installCert(domain, certName) {
  const inst = await run(
    'certbot',
    ['install', '--nginx', '--cert-name', certName, '--redirect', '--non-interactive'],
    { timeout: 120000 },
  );
  return { ok: inst.code === 0 && sslConfigured(domain), output: inst.stdout + '\n' + inst.stderr };
}

const account = (email) => (email ? ['-m', email] : ['--register-unsafely-without-email']);

/**
 * Prove ownership through a DNS TXT record instead of an inbound HTTP call.
 * This is the only thing that works when port 80 of the public name does not
 * land on this nginx — behind a proxying CDN, a NAT box or a host-level
 * reverse proxy — and it is also the only way to get a wildcard.
 */
async function issueViaDns({ domain, email, dryRun = false }) {
  const { plugin, credentials, propagationSeconds } = config.certbotDns;
  if (credentials && !fs.existsSync(credentials)) {
    return { ok: false, output: `CERTBOT_DNS_CREDENTIALS points at ${credentials}, which does not exist` };
  }
  const args = [
    'certonly',
    `--dns-${plugin}`,
    ...(credentials ? [`--dns-${plugin}-credentials`, credentials] : []),
    ...(propagationSeconds ? [`--dns-${plugin}-propagation-seconds`, String(propagationSeconds)] : []),
    '-d', domain,
    '--cert-name', path.basename(domain),
    '--non-interactive', '--agree-tos', '--keep-until-expiring',
    ...account(email),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  const result = await run('certbot', args, { timeout: 600000 }); // DNS propagation waits
  return { ok: result.code === 0, output: result.stdout + '\n' + result.stderr };
}

/**
 * Put HTTPS on the domain's server block.
 *
 * Three ways, in order of how little can go wrong:
 *  1. a certificate is already in /etc/letsencrypt (the domain was attached
 *     before, or issued by hand) — installing it is instant and offline;
 *  2. CERTBOT_DNS_PLUGIN is set — issue through a DNS TXT record, which
 *     needs no inbound HTTP at all, then install it;
 *  3. otherwise `certbot --nginx`, the classic HTTP-01 challenge, which
 *     needs port 80 of the public name to reach this nginx.
 */
export async function enableHttps({ domain, email }) {
  if (config.nginx.upstreamTls) {
    return {
      ok: true,
      upstream: true,
      method: 'terminated before nginx',
      output: 'HTTPS ends at the proxy in front of this server — no certificate is needed here.',
    };
  }
  const certName = path.basename(domain);
  if (fs.existsSync(`/etc/letsencrypt/live/${certName}/fullchain.pem`)) {
    const inst = await installCert(domain, certName);
    if (inst.ok) return { ...inst, reusedCert: true, method: 'existing certificate' };
    // fall through — a fresh issue can still succeed where install failed
  }

  if (config.certbotDns.plugin) {
    const issued = await issueViaDns({ domain, email });
    if (!issued.ok) return { ok: false, method: `dns-01 (${config.certbotDns.plugin})`, output: issued.output };
    const inst = await installCert(domain, certName);
    return { ...inst, method: `dns-01 (${config.certbotDns.plugin})`, output: issued.output + '\n' + inst.output };
  }

  const args = ['--nginx', '-d', domain, '--non-interactive', '--agree-tos', '--redirect', ...account(email)];
  const result = await run('certbot', args, { timeout: 120000 });
  return {
    // certbot can exit 0 without editing the config ("not yet due for
    // renewal") — only a 443 block in the config counts as success.
    ok: result.code === 0 && sslConfigured(domain),
    method: 'http-01 (nginx)',
    output: result.stdout + '\n' + result.stderr,
  };
}

/** Does the configured challenge actually work for this name? No cert issued. */
export async function testHttpsChallenge(domain, email) {
  if (!config.certbotDns.plugin) {
    return { ok: false, method: 'http-01 (nginx)', output: 'no DNS plugin configured — nothing to dry-run' };
  }
  const r = await issueViaDns({ domain, email, dryRun: true });
  return { ...r, method: `dns-01 (${config.certbotDns.plugin}) dry run` };
}
