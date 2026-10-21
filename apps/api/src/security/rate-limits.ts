/**
 * Rate limits (T15). HTTP rules are checked by middleware before routing (so they also protect
 * login and 404s); per-tenant and socket limits are checked where the tenant is known.
 */
export interface RateRule {
  name: string;
  limit: number;
  windowMs: number;
  matches(method: string, path: string): boolean;
}

const MINUTE = 60_000;

/** Never limited: health checks (monitoring) and Stripe webhooks (bursty, signature-protected). */
export function isExempt(method: string, path: string): boolean {
  return method === 'OPTIONS' || path === '/health' || path === '/billing/webhook';
}

export const HTTP_RULES: RateRule[] = [
  // Brute force: logins, signups and invite acceptance.
  {
    name: 'auth',
    limit: 10,
    windowMs: MINUTE,
    matches: (m, p) => m === 'POST' && /^\/auth\/(login|signup|invites\/accept)$/.test(p),
  },
  {
    name: 'refresh',
    limit: 30,
    windowMs: MINUTE,
    matches: (m, p) => m === 'POST' && p === '/auth/refresh',
  },
  // Public widget API, per visitor address.
  {
    name: 'chat',
    limit: 20,
    windowMs: MINUTE,
    matches: (m, p) => m === 'POST' && p === '/v1/chat',
  },
  {
    name: 'widget',
    limit: 60,
    windowMs: MINUTE,
    matches: (m, p) => m === 'GET' && p.startsWith('/widget/'),
  },
  // Everything: a burst of 100 requests a second from one address gets 429s.
  { name: 'ip', limit: 50, windowMs: 5_000, matches: () => true },
];

/** Per tenant, across all its visitors and API instances (cost protection). */
export const TENANT_CHAT_LIMIT = { limit: 600, windowMs: MINUTE };
/** Widget socket connections per address. */
export const SOCKET_CONNECT_LIMIT = { limit: 30, windowMs: MINUTE };
