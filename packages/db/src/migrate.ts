import { loadDotEnv } from '@supportpilot/shared/node';
import { runMigrations } from './index';

async function main(): Promise<void> {
  loadDotEnv(__dirname);
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env in the repo root.');
  }
  const pgvector = await runMigrations(url);
  console.log(`Migrations applied. pgvector ${pgvector ?? 'NOT installed'}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
