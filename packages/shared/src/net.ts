import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const value = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd][0-9a-f]{2}:/.test(lower) || // fc00::/7 unique local
      /^fe[89ab][0-9a-f]:/.test(lower) || // fe80::/10 link-local
      /^ff[0-9a-f]{2}:/.test(lower) // multicast
    );
  }
  return true; // not an IP at all: treat as unsafe
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * SSRF guard for user-supplied URLs (knowledge-base URL import).
 * Only http(s), no credentials, and every address the hostname resolves to must be public.
 * The fetcher must call this again right before connecting and must not follow redirects blindly.
 */
export async function assertPublicUrl(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https URLs are allowed');
  }
  if (url.username || url.password)
    throw new UnsafeUrlError('URLs with credentials are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal')
  ) {
    throw new UnsafeUrlError('Local addresses are not allowed');
  }
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolve(hostname);
    } catch {
      throw new UnsafeUrlError(`Could not resolve ${hostname}`);
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError('This URL points to a private or local network address');
  }
  return url;
}
