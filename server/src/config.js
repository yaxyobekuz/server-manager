import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const config = {
  port: Number(process.env.PORT) || 4500,
  adminPassword: process.env.ADMIN_PASSWORD || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  // Absolute path to the project root (one level up from /server)
  rootDir: path.join(__dirname, '..', '..'),
  dataDir: path.join(__dirname, '..', 'data'),
  clientDist: path.join(__dirname, '..', '..', 'client', 'dist'),
  // Where managed projects live: <projectsRoot>/<project>/<service>
  projectsRoot: process.env.PROJECTS_ROOT || '/var/www',
  /**
   * How certbot proves the domain is yours.
   *
   * Default (unset): the nginx/HTTP-01 challenge — Let's Encrypt calls back
   * on port 80. That needs port 80 of the public IP to actually reach THIS
   * nginx, which is not true behind a proxying CDN, a NAT box or a host-level
   * reverse proxy. Set a DNS plugin and the panel proves ownership through a
   * DNS TXT record instead, which works no matter how inbound HTTP is routed.
   */
  /**
   * How the server blocks the panel writes should listen.
   *
   * Default (unset): plain `listen 80`, which is right when the public IP
   * reaches this nginx directly. When something else owns the public ports —
   * a host-level reverse proxy, a CDN, a NAT box — set NGINX_LISTEN to the
   * address that proxy forwards to (e.g. 10.0.0.5:8080), NGINX_TRUSTED_PROXY
   * to its address so logs and metrics record the real client IP, and
   * NGINX_UPSTREAM_TLS=1 if HTTPS is already terminated before nginx (then
   * the panel never runs certbot — there is nothing here to encrypt).
   */
  nginx: {
    listen: (process.env.NGINX_LISTEN || '').trim(),
    trustedProxy: (process.env.NGINX_TRUSTED_PROXY || '').trim(),
    upstreamTls: /^(1|true|yes|on)$/i.test(process.env.NGINX_UPSTREAM_TLS || ''),
  },
  certbotDns: {
    plugin: /^[a-z0-9-]+$/.test(process.env.CERTBOT_DNS_PLUGIN || '')
      ? process.env.CERTBOT_DNS_PLUGIN
      : '', // e.g. cloudflare, route53, digitalocean
    credentials: process.env.CERTBOT_DNS_CREDENTIALS || '',
    propagationSeconds: Number(process.env.CERTBOT_DNS_PROPAGATION) || 0,
  },
};

if (!config.adminPassword) {
  console.warn(
    '[config] ADMIN_PASSWORD is not set — login will be disabled. Copy server/.env.example to server/.env and set it.'
  );
}
