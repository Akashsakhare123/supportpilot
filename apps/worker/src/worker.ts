import type { IngestionJob } from '@supportpilot/shared';
import { Worker, type ConnectionOptions, type WorkerOptions } from 'bullmq';
import { processIngestion, type IngestionDeps, type IngestionResult } from './processors/ingestion';

export interface IngestionWorkerOptions {
  queueName: string;
  connection: ConnectionOptions;
  deps: IngestionDeps;
  concurrency?: number;
  /** Lock / stalled-job timing; tests shorten these to simulate a crash quickly. */
  workerOptions?: Partial<
    Pick<WorkerOptions, 'lockDuration' | 'stalledInterval' | 'maxStalledCount'>
  >;
}

/**
 * BullMQ worker for the ingestion queue. If the process dies mid-job, the job's lock expires and
 * BullMQ hands it to the next worker ("stalled" job), so a crash never loses a document.
 */
export function createIngestionWorker(
  options: IngestionWorkerOptions,
): Worker<IngestionJob, IngestionResult> {
  return new Worker<IngestionJob, IngestionResult>(
    options.queueName,
    (job) => processIngestion(job, options.deps),
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 2,
      ...options.workerOptions,
    },
  );
}
