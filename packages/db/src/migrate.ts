import path from 'node:path';
import { loadDotEnv } from '@supportpilot/shared/node';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from './index';

async function main(): Promise<void> {
  loadDotEnv(__dirname);
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env in the repo root.');
  }
  const pool = createPool(url, { max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(__dirname, '../migrations') });
    const { rows } = await pool.query<{ extversion: string }>(
      "select extversion from pg_extension where extname = 'vector'",
    );
    console.log(`Migrations applied. pgvector ${rows[0]?.extversion ?? 'NOT installed'}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
