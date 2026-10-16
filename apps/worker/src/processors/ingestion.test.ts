import { describe, expect, it } from 'vitest';
import { processIngestion } from './ingestion';

describe('processIngestion', () => {
  it('accepts a valid job', async () => {
    const result = await processIngestion({
      documentId: '6f1c1a9e-2c1d-4f7e-9a51-0e6c1f1f2a10',
      tenantId: '0b7f5d4e-8a3c-4a59-b3c2-6d1e2f3a4b5c',
    });
    expect(result).toEqual({
      documentId: '6f1c1a9e-2c1d-4f7e-9a51-0e6c1f1f2a10',
      status: 'skipped',
      chunks: 0,
    });
  });

  it('rejects a job without tenantId so it fails visibly in the queue', async () => {
    await expect(processIngestion({ documentId: 'abc' })).rejects.toThrow();
  });
});
