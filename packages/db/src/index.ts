import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export { schema };
export type { Pool } from 'pg';

export type Database = NodePgDatabase<typeof schema>;

/** Postgres connection pool with sane defaults; fail fast instead of hanging when the DB is down. */
export function createPool(connectionString: string, options: PoolConfig = {}): Pool {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    ...options,
  });
}

/** Typed Drizzle client on top of a pool. Every tenant-owned query must filter by tenant_id. */
export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}
