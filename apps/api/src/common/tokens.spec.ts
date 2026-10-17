import { PUBLIC_KEY_PATTERN } from '@supportpilot/shared';
import { generatePublicKey, generateToken, hashToken } from './tokens';

describe('tokens', () => {
  it('generates long, unique, URL-safe tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically and never returns the token itself', () => {
    const token = generateToken();
    expect(hashToken(token)).toEqual(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it('generates unique pk_live_ public keys', () => {
    const key = generatePublicKey();
    expect(key).toMatch(PUBLIC_KEY_PATTERN);
    expect(key.startsWith('pk_live_')).toBe(true);
    expect(generatePublicKey()).not.toEqual(key);
  });
});
