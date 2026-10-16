import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from '@supportpilot/db';
import type { DependencyStatus, HealthReport } from '@supportpilot/shared';
import { Redis } from 'ioredis';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthReport> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    return {
      status: db.status === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      db: db.status,
      pgvector: db.pgvector,
      redis,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDb(): Promise<{ status: DependencyStatus; pgvector: string | null }> {
    try {
      const { rows } = await withTimeout(
        this.pool.query<{ extversion: string }>(
          "select extversion from pg_extension where extname = 'vector'",
        ),
        CHECK_TIMEOUT_MS,
        'postgres',
      );
      return { status: 'ok', pgvector: rows[0]?.extversion ?? null };
    } catch (error) {
      this.logger.warn(`Postgres health check failed: ${(error as Error).message}`);
      return { status: 'error', pgvector: null };
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      const pong = await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS, 'redis');
      return pong === 'PONG' ? 'ok' : 'error';
    } catch (error) {
      this.logger.warn(`Redis health check failed: ${(error as Error).message}`);
      return 'error';
    }
  }
}
