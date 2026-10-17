import { QUEUES } from '@supportpilot/shared';
import { baseEnvSchema, loadDotEnv, parseEnv } from '@supportpilot/shared/node';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { processIngestion } from './processors/ingestion';

loadDotEnv(__dirname);
const env = parseEnv(baseEnvSchema, process.env);

// BullMQ requires maxRetriesPerRequest: null on the worker's connection.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(QUEUES.ingestion, (job) => processIngestion(job.data), {
  connection,
  concurrency: 2,
});

worker.on('ready', () => console.log(`[worker] listening on queue "${QUEUES.ingestion}"`));
worker.on('completed', (job, result) => console.log(`[worker] job ${job.id} done`, result));
worker.on('failed', (job, error) =>
  console.error(`[worker] job ${job?.id} failed: ${error.message}`),
);
worker.on('error', (error) => console.error(`[worker] ${error.message}`));

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, finishing active jobs...`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
