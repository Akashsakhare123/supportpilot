import { DEFAULT_PORTS } from '@supportpilot/shared';
import { baseEnvSchema, parseEnv } from '@supportpilot/shared/node';
import { z } from 'zod';

/** Env vars for the worker. Validated once at startup. */
export const workerEnvSchema = baseEnvSchema.extend({
  /** Jobs processed in parallel. Embedding APIs are rate limited, so keep it small. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  /** Bull Board queue UI (development only). 0 turns it off. */
  BULL_BOARD_PORT: z.coerce.number().int().min(0).default(DEFAULT_PORTS.bullBoard),
  EMBEDDING_PROVIDER: z.enum(['local', 'mock', 'openai']).default('local'),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, env);
}
