import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The monorepo root (folder with pnpm-workspace.yaml), searching up from `startDir`. */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** Where uploaded files are stored locally: STORAGE_DIR or <repo>/.data/uploads. */
export function resolveStorageDir(env: NodeJS.ProcessEnv = process.env, startDir?: string): string {
  return env.STORAGE_DIR || join(findWorkspaceRoot(startDir), '.data', 'uploads');
}

/**
 * ioredis connection options from a redis:// or rediss:// URL. Passing options (not a client
 * instance) lets BullMQ own the connection, so queue.close() really disconnects it.
 */
export function redisOptionsFromUrl(url: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
} {
  const parsed = new URL(url);
  const db = parsed.pathname.replace('/', '');
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
