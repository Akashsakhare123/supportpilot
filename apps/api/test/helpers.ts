import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createDb, createPool, tenants, users } from '@supportpilot/db';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/config/env';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication(), loadEnv());
  await app.init();
  return app;
}

export const TEST_PASSWORD = 'correct-horse-battery';

export interface TestTenant {
  tenantId: string;
  owner: { id: string; email: string };
  admin: { id: string; email: string };
  agent: { id: string; email: string };
}

/** A fresh tenant with one user per role. Unique emails, so test runs never collide. */
export async function createTestTenant(label = 'Test Co'): Promise<TestTenant> {
  const pool = createPool(process.env.DATABASE_URL!, { max: 1 });
  const db = createDb(pool);
  const run = randomUUID().slice(0, 8);
  try {
    const passwordHash = await hash(TEST_PASSWORD);
    const [tenant] = await db
      .insert(tenants)
      .values({ name: `${label} ${run}`, publicKey: `pk_test_${run}_${randomUUID().slice(0, 8)}` })
      .returning();
    const make = (role: 'owner' | 'admin' | 'agent') => ({
      tenantId: tenant!.id,
      email: `${role}+${run}@example.test`,
      name: `${role} ${run}`,
      role,
      passwordHash,
    });
    const rows = await db
      .insert(users)
      .values([make('owner'), make('admin'), make('agent')])
      .returning();
    const byRole = (role: string) => {
      const row = rows.find((r) => r.role === role)!;
      return { id: row.id, email: row.email };
    };
    return {
      tenantId: tenant!.id,
      owner: byRole('owner'),
      admin: byRole('admin'),
      agent: byRole('agent'),
    };
  } finally {
    await pool.end();
  }
}

/** The refresh cookie value from a supertest response's Set-Cookie header. */
export function refreshCookieFrom(setCookie: string[] | string | undefined): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = all.find((c) => c.startsWith('sp_refresh=') && !c.startsWith('sp_refresh=;'));
  return cookie?.split(';')[0];
}
