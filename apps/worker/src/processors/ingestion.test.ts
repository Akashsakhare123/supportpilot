import { FetchPageError, LocalHashEmbeddings, type EmbeddedChunk } from '@supportpilot/ai';
import type { DocumentStatusEvent } from '@supportpilot/shared';
import { UnsafeUrlError } from '@supportpilot/shared/node';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  processIngestion,
  type DocumentRepository,
  type IngestDocument,
  type IngestionDeps,
  type JobLike,
} from './ingestion';

const TENANT = '0b7f5d4e-8a3c-4a59-b3c2-6d1e2f3a4b5c';
const DOC = '6f1c1a9e-2c1d-4f7e-9a51-0e6c1f1f2a10';

interface FakeRow extends IngestDocument {
  status: string;
  error: string | null;
  chunks: EmbeddedChunk[];
  model?: string;
}

function setup(overrides: Partial<IngestDocument> = {}, deps: Partial<IngestionDeps> = {}) {
  const rows = new Map<string, FakeRow>();
  rows.set(DOC, {
    id: DOC,
    tenantId: TENANT,
    title: 'Returns',
    sourceType: 'text',
    source: 'returns.md',
    storageKey: `${TENANT}/${DOC}.md`,
    status: 'queued',
    error: null,
    chunks: [],
    ...overrides,
  });
  const history: string[] = [];
  const events: DocumentStatusEvent[] = [];
  const repo: DocumentRepository = {
    async find(tenantId, id) {
      const row = rows.get(id);
      return row && row.tenantId === tenantId ? row : null;
    },
    async setStatus(_tenantId, id, status, error) {
      const row = rows.get(id)!;
      row.status = status;
      row.error = error;
      history.push(status);
    },
    async saveChunks(_tenantId, id, model, chunks) {
      const row = rows.get(id)!;
      Object.assign(row, { chunks, model, status: 'ready', error: null });
      history.push('ready');
      return chunks.length;
    },
  };
  const files = new Map<string, Buffer>([
    [`${TENANT}/${DOC}.md`, Buffer.from('\uFEFF# Returns\nReturn any bike within 30 days.')],
  ]);
  const fullDeps: IngestionDeps = {
    repo,
    storage: {
      async get(key) {
        const file = files.get(key);
        if (!file) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
        return file;
      },
    },
    embeddings: new LocalHashEmbeddings(),
    publish: (event) => void events.push(event),
    ...deps,
  };
  const row = () => rows.get(DOC)!;
  return { rows, row, history, events, deps: fullDeps };
}

const job = (
  attemptsMade = 0,
  attempts = 3,
  data: unknown = { documentId: DOC, tenantId: TENANT },
): JobLike => ({
  data,
  attemptsMade,
  opts: { attempts },
});

describe('processIngestion', () => {
  it('extracts, chunks, embeds and stores a text document', async () => {
    const t = setup();
    const result = await processIngestion(job(), t.deps);
    expect(result).toEqual({ documentId: DOC, status: 'ready', chunks: 1 });
    expect(t.history).toEqual(['processing', 'ready']);
    expect(t.row().model).toBe('local-hash-v1');
    expect(t.row().chunks[0]!.content).toBe('Return any bike within 30 days.'); // BOM stripped
    expect(t.row().chunks[0]!.headingPath).toEqual(['Returns']);
    expect(t.events.map((e) => e.status)).toEqual(['processing', 'ready']);
    expect(t.events[1]).toEqual({
      tenantId: TENANT,
      documentId: DOC,
      status: 'ready',
      error: null,
      chunkCount: 1,
    });
  });

  it('imports a URL with the page fetcher', async () => {
    const urls: string[] = [];
    const t = setup(
      { sourceType: 'url', source: 'https://shop.example/faq', storageKey: null },
      {
        fetchPage: async (url) => {
          urls.push(url);
          return { title: 'FAQ', text: '# Shipping\nWe ship in 3-5 days.' };
        },
      },
    );
    await processIngestion(job(), t.deps);
    expect(urls).toEqual(['https://shop.example/faq']);
    expect(t.row().status).toBe('ready');
  });

  it('reads PDFs from storage through the PDF extractor', async () => {
    const t = setup(
      { sourceType: 'pdf', source: 'manual.pdf', storageKey: `${TENANT}/${DOC}.md` },
      { extractPdf: async (bytes) => `PDF with ${bytes.length} bytes about tyre pressure.` },
    );
    await processIngestion(job(), t.deps);
    expect(t.row().chunks[0]!.content).toMatch(/tyre pressure/);
  });

  it('skips a job whose document was deleted', async () => {
    const t = setup();
    t.rows.clear();
    await expect(processIngestion(job(), t.deps)).resolves.toMatchObject({ status: 'skipped' });
    expect(t.history).toEqual([]);
  });

  it("never touches another tenant's document", async () => {
    const t = setup();
    const other = { documentId: DOC, tenantId: '11111111-2222-4333-8444-555555555555' };
    await expect(processIngestion(job(0, 3, other), t.deps)).resolves.toMatchObject({
      status: 'skipped',
    });
    expect(t.row().status).toBe('queued');
  });

  it('rejects a malformed job payload so it fails visibly in the queue', async () => {
    const t = setup();
    await expect(processIngestion(job(0, 3, { documentId: 'abc' }), t.deps)).rejects.toThrow();
  });

  it('puts the document back in the queue with the reason on a temporary error', async () => {
    const t = setup(
      {},
      {
        embeddings: {
          model: 'flaky',
          dimensions: 1536,
          embed: async () => {
            throw new Error('Embedding request failed: HTTP 503');
          },
        },
      },
    );
    await expect(processIngestion(job(0, 3), t.deps)).rejects.toThrow(/HTTP 503/);
    expect(t.row().status).toBe('queued');
    expect(t.row().error).toBe(
      'Attempt 1 of 3 failed: Embedding request failed: HTTP 503. Retrying automatically.',
    );
  });

  it('marks the document failed on the last attempt', async () => {
    const t = setup(
      {},
      {
        embeddings: {
          model: 'flaky',
          dimensions: 1536,
          embed: async () => {
            throw new Error('Embedding request failed: HTTP 503');
          },
        },
      },
    );
    await expect(processIngestion(job(2, 3), t.deps)).rejects.toThrow(/HTTP 503/);
    expect(t.row().status).toBe('failed');
    expect(t.row().error).toBe('Embedding request failed: HTTP 503');
    expect(t.events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it.each([
    ['an empty file', { storageKey: 'empty.md' }, /No readable text/],
    ['a missing upload', { storageKey: 'gone.md' }, /missing from storage/],
  ])('fails %s immediately without retries', async (_label, override, reason) => {
    const t = setup(override);
    t.deps.storage.get = async (key) => {
      if (key === 'empty.md') return Buffer.from('   \n');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const error = await processIngestion(job(0, 3), t.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(t.row().status).toBe('failed');
    expect(t.row().error).toMatch(reason);
  });

  it('fails permanently for a 404 page or a blocked URL, but retries a 503', async () => {
    const run = async (failure: Error) => {
      const t = setup(
        { sourceType: 'url', source: 'https://shop.example/x', storageKey: null },
        {
          fetchPage: async () => {
            throw failure;
          },
        },
      );
      const error = await processIngestion(job(0, 3), t.deps).catch((e: unknown) => e);
      return { error, status: t.row().status };
    };
    const notFound = await run(new FetchPageError('The page returned HTTP 404', false));
    expect(notFound.error).toBeInstanceOf(UnrecoverableError);
    expect(notFound.status).toBe('failed');

    const blocked = await run(new UnsafeUrlError('Blocked private address'));
    expect(blocked.error).toBeInstanceOf(UnrecoverableError);

    const down = await run(new FetchPageError('The page returned HTTP 503', true));
    expect(down.error).not.toBeInstanceOf(UnrecoverableError);
    expect(down.status).toBe('queued');
  });

  it('does not fail the job when publishing a status update fails', async () => {
    const t = setup(
      {},
      {
        publish: () => {
          throw new Error('redis down');
        },
      },
    );
    await expect(processIngestion(job(), t.deps)).resolves.toMatchObject({ status: 'ready' });
  });
});
