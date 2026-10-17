import { runMigrations } from '@supportpilot/db';
import { loadTestEnv } from './load-test-env';

/** Bring the test database schema up to date before the suites run. */
export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (or DATABASE_URL_TEST) must be set');
  await runMigrations(process.env.DATABASE_URL);
}
