import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

type Db = NodePgDatabase<typeof schema>;
export type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The role row-level security policies apply to (migration 0010). */
export const APP_ROLE = 'supportpilot_app';

/**
 * Run queries with Postgres row-level security as a second wall between tenants (T15): inside
 * one transaction the connection switches to the `supportpilot_app` role and sets
 * `app.tenant_id`, so every tenant table only shows (and only accepts) this tenant's rows, even
 * if a query forgets its `tenant_id` filter. Both settings end with the transaction.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('withTenant needs a tenant id');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return fn(tx);
  });
}
