import { describe, expect, it } from 'vitest';
import { ingestionJobSchema } from './jobs';

describe('ingestionJobSchema', () => {
  it('accepts uuids', () => {
    const job = {
      documentId: '6f1c1a9e-2c1d-4f7e-9a51-0e6c1f1f2a10',
      tenantId: '0b7f5d4e-8a3c-4a59-b3c2-6d1e2f3a4b5c',
    };
    expect(ingestionJobSchema.parse(job)).toEqual(job);
  });

  it('rejects missing tenant', () => {
    expect(ingestionJobSchema.safeParse({ documentId: 'x' }).success).toBe(false);
  });
});
