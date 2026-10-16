import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { ServerEnv } from '@supportpilot/shared/node';
import { Redis } from 'ioredis';
import { ENV } from '../config/env';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      // Fail fast: one retry per command, so /health reports "error" quickly when Redis is down.
      useFactory: (env: ServerEnv) =>
        new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3_000 }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
