import { loadDotEnv } from '@supportpilot/shared/node';

/** Env for integration tests: the dedicated test database and a fixed JWT secret if none is set. */
export function loadTestEnv(): void {
  loadDotEnv(__dirname);
  process.env.NODE_ENV = 'test';
  if (process.env.DATABASE_URL_TEST) process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  process.env.JWT_SECRET ??= 'integration-test-secret-not-for-production';
}
