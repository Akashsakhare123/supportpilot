import { runMigrations } from '@supportpilot/db';
import { loadTestEnv } from './load-test-env';

/** Runs once before all integration suites: bring the test database schema up to date. */
export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL (or DATABASE_URL_TEST) must be set for integration tests');
  await runMigrations(url);
}
