import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Environment variables used by the API and the worker. Validated once at startup. */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Parse and validate env vars, throwing one readable error that lists every problem. */
export function parseServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(env);
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
