import { loadDotEnv } from '@supportpilot/shared/node';

/** Same rules as the API's integration tests: use DATABASE_URL_TEST when it is set. */
export function loadTestEnv(): void {
  loadDotEnv(__dirname);
  process.env.NODE_ENV = 'test';
  if (process.env.DATABASE_URL_TEST) process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
