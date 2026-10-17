import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPrivateAddress, UnsafeUrlError } from './net';

const publicDns = async () => ['93.184.216.34'];
const privateDns = async () => ['10.1.2.3'];

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.20.1.1',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])('allows %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('assertPublicUrl', () => {
  it('accepts a public https URL', async () => {
    await expect(assertPublicUrl('https://example.com/help', publicDns)).resolves.toBeInstanceOf(
      URL,
    );
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:4000/health',
    'http://[::1]/',
    'http://10.0.0.5/',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'https://user:pass@example.com/',
    'not a url',
  ])('rejects %s', async (url) => {
    await expect(assertPublicUrl(url, publicDns)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects public-looking names that resolve to a private address (DNS rebinding style)', async () => {
    await expect(assertPublicUrl('https://evil.example.com/', privateDns)).rejects.toThrow(
      /private/,
    );
  });
});
