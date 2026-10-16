// Integration tests use the dedicated test database when DATABASE_URL_TEST is set.
import { loadDotEnv } from '@supportpilot/shared/node';

loadDotEnv(__dirname);
process.env.NODE_ENV = 'test';
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
