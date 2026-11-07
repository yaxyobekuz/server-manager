import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import * as store from '../store.js';
import { buildMcpServer } from '../mcp/server.js';

/**
 * The panel as an MCP server, reachable at one URL.
 *
 * Claude Desktop and Claude Code both take a remote MCP server as a plain
 * HTTPS address, so there is nothing to install on the user's computer:
 *
 *     https://<panel>/mcp?key=<access key>
 *
 * The key is the whole authentication story here. MCP's own answer is OAuth,
 * which a one-person panel has no use for, so instead the owner generates a
 * long random key in Settings and it travels in the URL (or in an
 * Authorization header, which Claude Code can send). It can be revoked from
 * the same place, which is the part that matters: a key in a config file on
 * a laptop is a key that can be lost.
 *
 * Tools run as the OWNER. That is stated plainly in the UI, because it is the
 * price of a URL that authenticates itself with one secret.
 */
const router = Router();

export const newKey = () => crypto.randomBytes(32).toString('base64url');

/** The key from the header or the query string, whichever the client used. */
function presentedKey(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return bearer || String(req.query.key || '').trim();
}

const sameKey = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

function authorize(req, res) {
  const expected = store.getSettings().mcpKey || '';
  if (!expected) {
    res.status(503).json(rpcError(-32000, 'MCP access is off — generate a key in the panel under Settings.'));
    return false;
  }
  if (!sameKey(presentedKey(req), expected)) {
    res
      .status(401)
      .json(rpcError(-32001, 'Wrong or missing key. Append ?key=<access key> to the URL, or send it as a bearer token.'));
    return false;
  }
  return true;
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * The tools reach the panel through its own HTTP API rather than its internals,
 * so every permission check, validation and side effect is exactly the one the
 * web UI gets. The loopback hop costs a millisecond and buys one set of rules.
 */
function loopbackApi() {
  const base = `http://127.0.0.1:${config.port}/api`;
  return async function api(method, path, body) {
    const token = jwt.sign({ role: 'owner' }, config.jwtSecret, { expiresIn: '5m' });
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      throw new Error(`Panel API unreachable: ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${method} ${path} failed (HTTP ${res.status})`);
    return data;
  };
}

router.post('/', async (req, res) => {
  if (!authorize(req, res)) return;

  // Stateless: one server and one transport per request, discarded after.
  // Nothing about a caller survives into the next request.
  const { server } = buildMcpServer(loopbackApi());
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Plain JSON replies instead of an SSE stream: simpler, and it survives
    // any proxy that buffers responses.
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json(rpcError(-32603, err.message));
  }
});

// The spec's GET (an open SSE stream for server-initiated messages) and DELETE
// (end a session) only mean something in stateful mode. Say so rather than
// hanging a client that tries.
router.get('/', (req, res) => {
  if (!authorize(req, res)) return;
  res.status(405).json(rpcError(-32000, 'This server is stateless — use POST.'));
});
router.delete('/', (req, res) => {
  if (!authorize(req, res)) return;
  res.status(405).json(rpcError(-32000, 'This server is stateless — there is no session to end.'));
});

export default router;
