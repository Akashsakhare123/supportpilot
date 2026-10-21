import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z, type ZodTypeAny } from 'zod';

/** Env vars every server process needs (API and worker). */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

/** An optional env var where an empty value (KEY= in .env) means "not set". */
const optional = <T extends ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/** Env vars for the API. Validated once at startup. */
export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /** Public URL of the dashboard, used in invite links. */
  APP_URL: z.string().url().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  /** Force the Secure cookie flag on/off; defaults to on in production. */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /**
   * Stripe billing (T13), all optional: without them billing shows plans and usage but upgrades
   * are off. Use test-mode keys (sk_test_...) in development.
   */
  STRIPE_SECRET_KEY: optional(
    z.string().startsWith('sk_', 'STRIPE_SECRET_KEY must start with sk_'),
  ),
  STRIPE_WEBHOOK_SECRET: optional(
    z.string().startsWith('whsec_', 'STRIPE_WEBHOOK_SECRET must start with whsec_'),
  ),
  STRIPE_PRICE_PRO: optional(
    z.string().startsWith('price_', 'STRIPE_PRICE_PRO must be a price id'),
  ),
  STRIPE_PRICE_BUSINESS: optional(
    z.string().startsWith('price_', 'STRIPE_PRICE_BUSINESS must be a price id'),
  ),
  /**
   * Rate limits (T15) are multiplied by this (e.g. 1000 in integration tests that send many
   * requests from one address). 0 turns rate limiting off.
   */
  RATE_LIMIT_MULTIPLIER: z.coerce.number().min(0).default(1),
  /**
   * Express "trust proxy": which proxies may set X-Forwarded-For (the client IP for rate limits).
   * loopback = the dashboard's /api proxy on the same machine; in production the platform's proxy.
   */
  TRUST_PROXY: z.string().default('loopback'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
/** @deprecated use ApiEnv */
export type ServerEnv = ApiEnv;

/** Parse env vars with a schema, throwing one readable error that lists every problem. */
export function parseEnv<S extends ZodTypeAny>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment variables:\n${problems}\nSee .env.example in the repo root.`,
    );
  }
  return result.data;
}

/** Validate the API environment. */
export function parseServerEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, env);
}

/**
 * Load the nearest `.env` walking up from `startDir` to the monorepo root (the folder with
 * pnpm-workspace.yaml). Existing env vars are never overwritten. Returns the file path or null.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
