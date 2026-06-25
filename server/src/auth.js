import jwt from 'jsonwebtoken';
import { config } from './config.js';

/**
 * Single admin-password auth. The GUI sends the password once, gets a JWT,
 * then includes the token on every request.
 */

export function login(password) {
  if (!config.adminPassword) {
    return { ok: false, error: 'Admin password is not configured on the server.' };
  }
  if (password !== config.adminPassword) {
    return { ok: false, error: 'Incorrect password.' };
  }
  const token = jwt.sign({ role: 'admin' }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
  return { ok: true, token };
}

/** Express middleware — rejects requests without a valid token. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Verify a token string directly (used by the WebSocket handshake). */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}
