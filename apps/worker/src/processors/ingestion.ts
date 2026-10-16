import { ingestionJobSchema, type IngestionJob } from '@supportpilot/shared';

export interface IngestionResult {
  documentId: string;
  status: 'skipped' | 'ready';
  chunks: number;
}

/**
 * Ingestion job: extract -> chunk -> embed -> store (implemented in T05/T06).
 * For now it only validates the payload so the queue wiring can be tested end to end.
 */
export async function processIngestion(data: unknown): Promise<IngestionResult> {
  const job: IngestionJob = ingestionJobSchema.parse(data);
  return { documentId: job.documentId, status: 'skipped', chunks: 0 };
}
