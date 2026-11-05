import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Symmetric at-rest encryption for the few secrets the panel must keep in
 * REUSABLE form — today only the password of a linked server (we have to
 * replay it to log in again when the session token expires, so a one-way
 * hash is not an option).
 *
 * The key is derived from JWT_SECRET (already the panel's root secret, kept
 * in server/.env with 600 perms), so db.json alone never reveals a password.
 * Rotating JWT_SECRET therefore invalidates saved server passwords — the UI
 * detects that and simply asks for the password again.
 */

let cachedKey = null;
const key = () => (cachedKey ||= crypto.scryptSync(config.jwtSecret, 'server-manager/secretbox/v1', 32));

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join(':');
}

/** Decrypt a sealed value. Returns null when it cannot be opened. */
export function unseal(blob) {
  const parts = String(blob || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const [, iv, tag, ct] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key (JWT_SECRET rotated) or tampered value
  }
}
