import { z } from 'zod';

/** Payload of a job on the `ingestion` queue (producer: T04, consumer: T06). */
export const ingestionJobSchema = z.object({
  documentId: z.string().uuid(),
  tenantId: z.string().uuid(),
});

export type IngestionJob = z.infer<typeof ingestionJobSchema>;
