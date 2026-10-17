import { z } from 'zod';

/** Per-tenant widget branding (edited in onboarding / settings, applied by the widget). */
export interface TenantBranding {
  primaryColor?: string;
  logoUrl?: string;
  greeting?: string;
  position?: 'right' | 'left';
}

export const DEFAULT_BRANDING: Required<TenantBranding> = {
  primaryColor: '#3b3f8c',
  logoUrl: '',
  greeting: 'Hi! How can we help?',
  position: 'right',
};

/** Fill missing branding fields with defaults. */
export function resolveBranding(
  branding: TenantBranding | null | undefined,
): Required<TenantBranding> {
  return { ...DEFAULT_BRANDING, ...(branding ?? {}) };
}

/** Widget public keys look like pk_live_xxx (generated) or pk_test_xxx (seed / tests). */
export const PUBLIC_KEY_PATTERN = /^pk_(live|test)_[A-Za-z0-9_-]{4,64}$/;

/**
 * Normalise what a user types into an allowed-domain field:
 * "https://WWW.Shop.com:443/path" -> "www.shop.com", "*.shop.com" -> "shop.com".
 * Returns null when it is not a valid hostname.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  value = value.split(/[/?#]/)[0] ?? ''; // path, query, hash
  value = value.replace(/:\d+$/, ''); // port
  value = value.replace(/^\*\./, ''); // wildcard prefix: subdomains are always allowed
  value = value.replace(/\.$/, '');
  if (value === 'localhost') return value;
  const hostname = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  return hostname.test(value) || ipv4.test(value) ? value : null;
}

/**
 * Is a browser Origin allowed to load this tenant's widget?
 * An empty list means "not configured yet": every origin is allowed. Otherwise the origin's
 * hostname must equal an allowed domain or be a subdomain of one.
 */
export function isOriginAllowed(origin: string | undefined, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0 || !origin) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #3b3f8c');

export const brandingSchema = z.object({
  primaryColor: hexColor,
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) => value === '' || /^https?:\/\/\S+$/i.test(value),
      'Logo must be an http(s) URL',
    ),
  greeting: z.string().trim().min(1, 'Greeting is required').max(140),
  position: z.enum(['right', 'left']),
});

export const allowedDomainsSchema = z
  .array(z.string())
  .max(20, 'At most 20 domains')
  .transform((values, ctx) => {
    const out: string[] = [];
    for (const value of values) {
      const domain = normalizeDomain(value);
      if (!domain) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" is not a valid domain` });
        return z.NEVER;
      }
      if (!out.includes(domain)) out.push(domain);
    }
    return out;
  });

export const companyNameSchema = z.string().trim().min(2, 'Company name is too short').max(80);

export const updateTenantSchema = z
  .object({
    name: companyNameSchema.optional(),
    branding: brandingSchema.optional(),
    allowedDomains: allowedDomainsSchema.optional(),
    onboardingCompleted: z.literal(true).optional(),
  })
  .strict();
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

/** Tenant settings as admins see them in the dashboard. */
export interface TenantSettings {
  id: string;
  name: string;
  plan: string;
  publicKey: string;
  branding: Required<TenantBranding>;
  allowedDomains: string[];
  handoffThreshold: number;
  onboardingCompleted: boolean;
}

/** Public widget config: safe to serve to any website. Never add secrets here. */
export interface WidgetConfig {
  tenantName: string;
  branding: Required<TenantBranding>;
}

/** The script tag a client pastes into their website. */
export function embedSnippet(widgetBaseUrl: string, publicKey: string): string {
  const base = widgetBaseUrl.replace(/\/+$/, '');
  return `<script src="${base}/widget.js" data-supportpilot data-key="${publicKey}" async></script>`;
}
