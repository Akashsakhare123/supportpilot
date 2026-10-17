import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Used for refresh tokens and invite links. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes, so a database leak does not leak usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Widget public key: identifies a tenant to the widget. Public by design, rotatable. */
export function generatePublicKey(): string {
  return `pk_live_${randomBytes(18).toString('base64url')}`;
}
