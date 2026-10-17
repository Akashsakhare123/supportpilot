import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type IngestionJob, QUEUES } from '@supportpilot/shared';
import { type ApiEnv, redisOptionsFromUrl } from '@supportpilot/shared/node';
import { Queue } from 'bullmq';
import { ENV } from '../config/env';

export const INGESTION_QUEUE = Symbol('INGESTION_QUEUE');
export type IngestionQueue = Queue<IngestionJob>;

/** Producer side of the BullMQ `ingestion` queue (the worker app consumes it). */
@Global()
@Module({
  providers: [
    {
      provide: INGESTION_QUEUE,
      inject: [ENV],
      useFactory: (env: ApiEnv): IngestionQueue =>
        new Queue<IngestionJob>(QUEUES.ingestion, {
          // Options, not a client: the queue owns the connection and close() disconnects it.
          connection: redisOptionsFromUrl(env.REDIS_URL),
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          },
        }),
    },
  ],
  exports: [INGESTION_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(INGESTION_QUEUE) private readonly queue: IngestionQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
