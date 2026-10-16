import { loadDotEnv } from '@supportpilot/shared/node';
import { defineConfig } from 'drizzle-kit';

loadDotEnv(__dirname);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://supportpilot:supportpilot@localhost:5432/supportpilot',
  },
  strict: true,
  verbose: true,
});
