import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Queue } from 'bullmq';
import express from 'express';
import type { Server } from 'node:http';

/** Bull Board UI for local development: jobs, retries, failures and their errors. */
export function startBullBoard(queues: Queue[], port: number): Server {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/');
  createBullBoard({ queues: queues.map((q) => new BullMQAdapter(q)), serverAdapter });
  const app = express();
  app.use('/', serverAdapter.getRouter());
  // Local only: never listen on all interfaces.
  return app.listen(port, '127.0.0.1');
}
