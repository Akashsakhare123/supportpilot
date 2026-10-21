import { createEmbeddingProvider } from '@supportpilot/ai';
import { createDb, createPool } from '@supportpilot/db';
import { CHANNELS, QUEUES } from '@supportpilot/shared';
import { createFileStorage, loadDotEnv, redisOptionsFromUrl } from '@supportpilot/shared/node';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Server } from 'node:http';
import { loadWorkerEnv } from './env';
import { initMonitoring, reportJobFailure } from './monitoring';
import { createDocumentRepository } from './repository';
import { createIngestionWorker } from './worker';

loadDotEnv(__dirname);
const env = loadWorkerEnv();
initMonitoring();
const connection = redisOptionsFromUrl(env.REDIS_URL);

const pool = createPool(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 2 });
const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
const embeddings = createEmbeddingProvider(process.env);
const storage = createFileStorage(process.env, __dirname);

const worker = createIngestionWorker({
  queueName: QUEUES.ingestion,
  connection,
  concurrency: env.WORKER_CONCURRENCY,
  deps: {
    repo: createDocumentRepository(createDb(pool)),
    storage,
    embeddings,
    publish: (event) => publisher.publish(CHANNELS.documentStatus, JSON.stringify(event)),
    log: (message) => console.log(`[worker] ${message}`),
  },
});

worker.on('ready', () =>
  console.log(
    `[worker] listening on queue "${QUEUES.ingestion}" (concurrency ${env.WORKER_CONCURRENCY}, embeddings ${embeddings.model}, storage ${storage.root})`,
  ),
);
worker.on('failed', (job, error) => {
  console.error(
    `[worker] job ${job?.id} attempt ${job?.attemptsMade ?? '?'} failed: ${error.message}`,
  );
  reportJobFailure(error, job);
});
worker.on('stalled', (jobId) => console.warn(`[worker] job ${jobId} stalled, it will be retried`));
worker.on('error', (error) => console.error(`[worker] ${error.message}`));

let board: { server: Server; queue: Queue } | null = null;
if (env.NODE_ENV !== 'production' && env.BULL_BOARD_PORT > 0) {
  void import('./bull-board')
    .then(({ startBullBoard }) => {
      const queue = new Queue(QUEUES.ingestion, { connection });
      const server = startBullBoard([queue], env.BULL_BOARD_PORT);
      server.on('listening', () =>
        console.log(`[worker] Bull Board: http://localhost:${env.BULL_BOARD_PORT}`),
      );
      server.on('error', (error) =>
        console.warn(`[worker] Bull Board not started: ${error.message}`),
      );
      board = { server, queue };
    })
    .catch((error: unknown) => console.warn(`[worker] Bull Board not started: ${String(error)}`));
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received, finishing active jobs...`);
  // Graceful: waits for running jobs; anything cut off is picked up again as a stalled job.
  await worker.close();
  if (board) {
    board.server.close();
    await board.queue.close();
  }
  publisher.disconnect();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
