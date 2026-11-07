import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { login, authFrom, verifyToken } from '../auth.js';
import { buildMcpServer } from '../mcp/server.js';

/**
 * The panel as an MCP server, reachable at one URL.
 *
 * Claude Desktop and Claude Code both take a remote MCP server as a plain
 * HTTPS address, so there is nothing to install. Connecting is the panel's
 * address and the panel's password, and nothing else:
 *
 *     https://<panel>/mcp?password=<the password you log in with>
 *
 * The password can also travel as `Authorization: Bearer <password>` for a
 * client that sends headers. There is no separate key to generate, rotate or
 * forget: it is the same credential as the login box, checked by the same
 * function, which means changing the password in server/.env also changes
 * this, and an admin password works too — with exactly that admin's
 * permissions, because the token the tools run on is the one login issues.
 */
const router = Router();

const rpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/** The password from the query string or the Authorization header. */
function presentedPassword(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return bearer || String(req.query.password || req.query.key || '');
}

/**
 * Authenticate exactly as the login box does, and return the identity the
 * tools will run as. A wrong password gets the same answer as a missing one.
 */
function authenticate(req, res) {
  if (!config.adminPassword) {
    res.status(503).json(rpcError(-32000, 'The panel has no ADMIN_PASSWORD set, so there is nothing to log in with.'));
    return null;
  }
  const result = login(presentedPassword(req));
  if (!result.ok) {
    res
      .status(401)
      .json(
        rpcError(
          -32001,
          'Wrong or missing password. The URL ends with ?password=<your panel password>, or send it as a bearer token.'
        )
      );
    return null;
  }
  const auth = authFrom(verifyToken(result.token));
  if (!auth) {
    res.status(401).json(rpcError(-32001, 'That password is no longer valid.'));
    return null;
  }
  return { token: result.token, auth };
}

/**
 * The tools reach the panel through its own HTTP API rather than its
 * internals, carrying the token login just issued — so every permission
 * check, validation and side effect is the one the web UI gets, for that
 * same identity. The loopback hop costs a millisecond and buys one copy of
 * the rules.
 */
function loopbackApi(token) {
  const base = `http://127.0.0.1:${config.port}/api`;
  return async function api(method, path, body) {
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
  const identity = authenticate(req, res);
  if (!identity) return;

  // Stateless: one server and one transport per request, discarded after, so
  // nothing about a caller survives into the next one.
  const { server } = buildMcpServer(loopbackApi(identity.token));
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
// leaving a client that tries them hanging.
router.get('/', (req, res) => {
  if (!authenticate(req, res)) return;
  res.status(405).json(rpcError(-32000, 'This server is stateless — use POST.'));
});
router.delete('/', (req, res) => {
  if (!authenticate(req, res)) return;
  res.status(405).json(rpcError(-32000, 'This server is stateless — there is no session to end.'));
});

export default router;
