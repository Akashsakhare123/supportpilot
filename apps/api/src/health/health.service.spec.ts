import { Test } from '@nestjs/testing';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { HealthService } from './health.service';

async function makeService(pool: object, redis: object): Promise<HealthService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HealthService,
      { provide: PG_POOL, useValue: pool },
      { provide: REDIS, useValue: redis },
    ],
  }).compile();
  return moduleRef.get(HealthService);
}

describe('HealthService', () => {
  const okPool = { query: jest.fn().mockResolvedValue({ rows: [{ extversion: '0.8.0' }] }) };
  const okRedis = { ping: jest.fn().mockResolvedValue('PONG') };

  it('reports ok when Postgres and Redis respond', async () => {
    const report = await (await makeService(okPool, okRedis)).check();
    expect(report).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok', pgvector: '0.8.0' });
  });

  it('reports pgvector null when the extension is not installed', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const report = await (await makeService(pool, okRedis)).check();
    expect(report).toMatchObject({ status: 'ok', pgvector: null });
  });

  it('reports degraded when Postgres fails', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const report = await (await makeService(pool, okRedis)).check();
    expect(report).toMatchObject({ status: 'degraded', db: 'error', redis: 'ok' });
  });

  it('reports degraded when Redis fails', async () => {
    const redis = { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const report = await (await makeService(okPool, redis)).check();
    expect(report).toMatchObject({ status: 'degraded', db: 'ok', redis: 'error' });
  });
});
