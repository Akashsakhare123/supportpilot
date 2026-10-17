import { describe, expect, it } from 'vitest';
import {
  allowedDomainsSchema,
  brandingSchema,
  embedSnippet,
  isOriginAllowed,
  normalizeDomain,
  PUBLIC_KEY_PATTERN,
  resolveBranding,
  updateTenantSchema,
} from './tenant';

describe('normalizeDomain', () => {
  it.each([
    ['https://WWW.Shop.com:443/path?q=1', 'www.shop.com'],
    ['shop.co.uk', 'shop.co.uk'],
    ['*.shop.com', 'shop.com'],
    ['localhost:5173', 'localhost'],
    ['http://127.0.0.1:8080', '127.0.0.1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(['', 'not a domain', 'shop', 'https://', '-bad-.com'])('rejects %j', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  const allowed = ['shop.example.com', 'localhost'];

  it('allows everything while no domains are configured', () => {
    expect(isOriginAllowed('https://anything.test', [])).toBe(true);
  });

  it('allows exact matches and subdomains', () => {
    expect(isOriginAllowed('https://shop.example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://www.shop.example.com', allowed)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', allowed)).toBe(true);
  });

  it('rejects other sites, including look-alike suffixes', () => {
    expect(isOriginAllowed('https://evil.test', allowed)).toBe(false);
    expect(isOriginAllowed('https://notshop.example.com.evil.test', allowed)).toBe(false);
    expect(isOriginAllowed('https://evilshop.example.com', allowed)).toBe(false);
    expect(isOriginAllowed('null', allowed)).toBe(false);
  });

  it('allows requests without an Origin header (not from a browser page)', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });
});

describe('schemas', () => {
  it('normalises and de-duplicates allowed domains', () => {
    expect(allowedDomainsSchema.parse(['https://Shop.com', 'shop.com/', 'www.shop.com'])).toEqual([
      'shop.com',
      'www.shop.com',
    ]);
    expect(allowedDomainsSchema.safeParse(['nope']).success).toBe(false);
  });

  it('validates branding', () => {
    const ok = { primaryColor: '#112233', logoUrl: '', greeting: 'Hello', position: 'left' };
    expect(brandingSchema.parse(ok)).toEqual(ok);
    expect(brandingSchema.safeParse({ ...ok, primaryColor: 'red' }).success).toBe(false);
    expect(brandingSchema.safeParse({ ...ok, logoUrl: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('rejects unknown tenant fields (no mass assignment of plan or keys)', () => {
    expect(updateTenantSchema.safeParse({ plan: 'business' }).success).toBe(false);
    expect(updateTenantSchema.safeParse({ publicKey: 'pk_live_x' }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('fills branding defaults', () => {
    expect(resolveBranding({ greeting: 'Yo' })).toMatchObject({
      greeting: 'Yo',
      position: 'right',
    });
  });

  it('builds the embed snippet', () => {
    expect(embedSnippet('https://cdn.example.com/', 'pk_live_abc123')).toBe(
      '<script src="https://cdn.example.com/widget.js" data-supportpilot data-key="pk_live_abc123" async></script>',
    );
  });

  it('recognises public keys', () => {
    expect(PUBLIC_KEY_PATTERN.test('pk_live_AbC-123_xyz')).toBe(true);
    expect(PUBLIC_KEY_PATTERN.test('pk_test_demo')).toBe(true);
    expect(PUBLIC_KEY_PATTERN.test('sk_live_abc')).toBe(false);
  });
});
