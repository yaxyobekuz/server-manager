import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Talks to ANOTHER machine running this same panel.
 *
 * Authentication is exactly what a human does: POST /api/login with that
 * server's admin password, keep the returned JWT for the session. The
 * password is stored once (sealed) per linked server, so the operator is
 * asked for it only the first time.
 *
 * Written on node:http(s) rather than fetch() because a transfer needs
 * things fetch makes awkward: byte-level upload/download progress, a
 * multi-gigabyte body streamed straight from/to a file, a per-request
 * "accept a self-signed certificate" switch and an idle (not total) timeout.
 */

export const PROTOCOL = 1;

export class RemoteError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Accepts "panel.example.com", "panel.example.com:4500", a full URL, and a
 * URL with a sub-path (a panel behind a proxy at /deploy) — the path is kept
 * as a prefix for every call.
 */
export function normalizeUrl(raw) {
  let text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) throw new RemoteError('Server URL is required');
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new RemoteError(`"${raw}" is not a valid server URL`);
  }
  if (!u.hostname) throw new RemoteError(`"${raw}" is not a valid server URL`);
  const prefix = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${prefix}`;
}

const IDLE_TIMEOUT = 300_000; // 5 min without a single byte = dead connection

export class Remote {
  constructor({ url, password, insecure = false, name = '' } = {}) {
    this.base = normalizeUrl(url);
    this.password = password || '';
    this.insecure = Boolean(insecure);
    this.name = name || this.base;
    this.token = null;
  }

  get label() {
    return this.name === this.base ? this.base : `${this.name} (${this.base})`;
  }

  /* ------------------------------------------------------------- transport */

  /**
   * One request. `body` is a JSON value or a {file} to stream up; the
   * response is parsed as JSON unless `toFile` is given.
   */
  request({ method = 'GET', path, body, toFile, onProgress, headers = {}, redirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.base + path);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const reqHeaders = { accept: 'application/json', ...headers };

      let payload = null;
      let fileSize = 0;
      if (body?.file) {
        fileSize = fs.statSync(body.file).size;
        reqHeaders['content-type'] = 'application/octet-stream';
        reqHeaders['content-length'] = String(fileSize);
      } else if (body !== undefined && body !== null) {
        payload = Buffer.from(JSON.stringify(body));
        reqHeaders['content-type'] = 'application/json';
        reqHeaders['content-length'] = String(payload.length);
      }
      if (this.token) reqHeaders.authorization = `Bearer ${this.token}`;

      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers: reqHeaders,
          ...(isHttps ? { rejectUnauthorized: !this.insecure, servername: url.hostname } : {}),
        },
        (res) => {
          const status = res.statusCode || 0;

          // A panel behind a redirecting proxy (http -> https) must still work.
          if ([301, 302, 307, 308].includes(status) && res.headers.location && redirects > 0 && !body?.file) {
            res.resume();
            let target;
            try {
              target = new URL(res.headers.location, url);
            } catch {
              return reject(new RemoteError(`Bad redirect from ${this.base}`, { status }));
            }
            const follow = new Remote({
              url: `${target.protocol}//${target.host}`,
              password: this.password,
              insecure: this.insecure,
              name: this.name,
            });
            follow.token = this.token;
            return follow
              .request({ method, path: target.pathname + target.search, body, toFile, onProgress, headers, redirects: redirects - 1 })
              .then(resolve, reject);
          }

          const fail = (text) => {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* html error page from a proxy */
            }
            const reason =
              parsed?.error ||
              (status === 401
                ? 'the saved password was rejected'
                : status === 403
                  ? 'that password is not the owner password on the other server'
                  : status === 404
                    ? 'this endpoint does not exist there — the other panel is older than this one'
                    : String(text || '').slice(0, 300).replace(/\s+/g, ' ').trim() || `HTTP ${status}`);
            reject(new RemoteError(reason, { status, body: String(text || '').slice(0, 2000) }));
          };

          if (status < 200 || status >= 300) {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
              if (text.length < 4000) text += c;
            });
            res.on('end', () => fail(text));
            return;
          }

          const total = Number(res.headers['content-length'] || 0);
          let done = 0;
          res.on('data', (chunk) => {
            done += chunk.length;
            onProgress?.(done, total);
          });

          if (toFile) {
            const out = fs.createWriteStream(toFile);
            res.pipe(out);
            out.on('error', (e) => reject(new RemoteError(`Cannot write ${toFile}: ${e.message}`)));
            out.on('finish', () => resolve({ status, bytes: done, file: toFile, total }));
            return;
          }

          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new RemoteError(`${this.base} did not answer with JSON — is that really a Deploy panel?`, { status, body: text.slice(0, 300) }));
            }
          });
        }
      );

      req.setTimeout(IDLE_TIMEOUT, () => {
        req.destroy(new RemoteError(`${this.base} stopped responding (no data for ${IDLE_TIMEOUT / 1000}s)`));
      });
      req.on('error', (err) => {
        if (err instanceof RemoteError) return reject(err);
        const hint =
          err.code === 'ECONNREFUSED' ? 'connection refused — is the panel running and the port open?'
          : err.code === 'ENOTFOUND' ? 'host not found — check the URL'
          : err.code === 'ETIMEDOUT' ? 'connection timed out'
          : /certificate|SELF_SIGNED|CERT_/i.test(err.code || err.message) ? `TLS error (${err.code || err.message}) — tick "accept a self-signed certificate" if that is expected`
          : err.message;
        reject(new RemoteError(`${this.base}: ${hint}`, { status: 0 }));
      });

      if (body?.file) {
        const src = fs.createReadStream(body.file);
        let sent = 0;
        src.on('data', (c) => {
          sent += c.length;
          onProgress?.(sent, fileSize);
        });
        src.on('error', (e) => req.destroy(new RemoteError(`Cannot read ${body.file}: ${e.message}`)));
        src.pipe(req);
      } else {
        if (payload) req.write(payload);
        req.end();
      }
    });
  }

  /* ------------------------------------------------------------------ auth */

  async login() {
    if (!this.password) {
      throw new RemoteError(`No password saved for ${this.label} — open Servers and enter it again.`);
    }
    const prev = this.token;
    this.token = null;
    try {
      const res = await this.request({ method: 'POST', path: '/api/login', body: { password: this.password } });
      if (!res?.token) throw new RemoteError(`${this.label} did not return a session token`);
      this.token = res.token;
      return this.token;
    } catch (err) {
      this.token = prev;
      throw err;
    }
  }

  /** Authenticated call; logs in on demand and once more after a 401. */
  async call(method, path, body, extra = {}) {
    if (!this.token) await this.login();
    try {
      return await this.request({ method, path, body, ...extra });
    } catch (err) {
      if (err instanceof RemoteError && err.status === 401) {
        await this.login();
        return this.request({ method, path, body, ...extra });
      }
      throw err;
    }
  }

  /* ----------------------------------------------------------- panel calls */

  hello() {
    return this.call('GET', '/api/transfer/hello');
  }

  catalog() {
    return this.call('GET', '/api/transfer/catalog');
  }

  plan(projectId, options) {
    return this.call('POST', `/api/transfer/plan/${projectId}`, { options });
  }

  preflight(plan, options) {
    return this.call('POST', '/api/transfer/preflight', { plan, options });
  }

  /** Ask the remote to build a bundle and stream it into a local file. */
  bundle(projectId, options, destFile, onProgress) {
    return this.call('POST', `/api/transfer/bundle/${projectId}`, { options }, {
      toFile: destFile,
      onProgress,
      headers: { accept: 'application/octet-stream' },
    });
  }

  /** Upload a bundle; the remote answers with a job id to poll. */
  apply(file, options, onProgress, from = '') {
    const query = `?options=${Buffer.from(JSON.stringify(options || {})).toString('base64url')}`;
    return this.call('POST', `/api/transfer/apply${query}`, { file }, {
      onProgress,
      headers: from ? { 'x-sm-from': from } : {},
    });
  }

  job(jobId, since = 0) {
    return this.call('GET', `/api/transfer/jobs/${jobId}?since=${since}`);
  }

  quiesce(projectId) {
    return this.call('POST', `/api/transfer/quiesce/${projectId}`);
  }

  resume(projectId) {
    return this.call('POST', `/api/transfer/resume/${projectId}`);
  }

  release(projectId, options) {
    return this.call('POST', `/api/transfer/release/${projectId}`, { options });
  }
}
