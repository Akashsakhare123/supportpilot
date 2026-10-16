import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, createPool, type Pool } from '@supportpilot/db';
import type { ServerEnv } from '@supportpilot/shared/node';
import { ENV } from '../config/env';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: ServerEnv) => createPool(env.DATABASE_URL),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => createDb(pool),
    },
  ],
  exports: [PG_POOL, DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
