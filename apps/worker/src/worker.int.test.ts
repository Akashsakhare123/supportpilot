import { LocalHashEmbeddings, type EmbeddingProvider } from '@supportpilot/ai';
import {
  createDb,
  createPool,
  documents,
  eq,
  listDocumentChunks,
  searchChunks,
  tenants,
  type Database,
  type Pool,
} from '@supportpilot/db';
import { LocalFileStorage, redisOptionsFromUrl } from '@supportpilot/shared/node';
import { Queue, type Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { IngestionDeps } from './processors/ingestion';
import { createDocumentRepository } from './repository';
import { createIngestionWorker } from './worker';

describe('Ingestion worker on Postgres + Redis (T06)', () => {
  const connection = redisOptionsFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379');
  // A private queue per run, so these jobs never mix with the API's or a running dev worker.
  const queueName = `ingestion-test-${randomUUID().slice(0, 8)}`;
  const embeddings = new LocalHashEmbeddings();
  let pool: Pool;
  let db: Database;
  let storage: LocalFileStorage;
  let storageDir: string;
  let queue: Queue;
  let tenantId: string;
  const workers: Worker[] = [];

  const deps = (overrides: Partial<IngestionDeps> = {}): IngestionDeps => ({
    repo: createDocumentRepository(db),
    storage,
    embeddings,
    ...overrides,
  });

  function startWorker(
    overrides: Partial<IngestionDeps> = {},
    workerOptions: Parameters<typeof createIngestionWorker>[0]['workerOptions'] = {},
  ): Worker {
    const worker = createIngestionWorker({
      queueName,
      connection,
      deps: deps(overrides),
      concurrency: 1,
      workerOptions: { stalledInterval: 1_000, ...workerOptions },
    });
    workers.push(worker);
    return worker;
  }

  async function createDocument(fileName: string, content: string): Promise<string> {
    const id = randomUUID();
    const storageKey = `${tenantId}/${id}.md`;
    await storage.put(storageKey, Buffer.from(content));
    await db.insert(documents).values({
      id,
      tenantId,
      title: fileName.replace(/\.md$/, ''),
      sourceType: 'text',
      source: fileName,
      storageKey,
    });
    await queue.add('ingest', { documentId: id, tenantId });
    return id;
  }

  async function document(id: string) {
    const [row] = await db.select().from(documents).where(eq(documents.id, id));
    return row!;
  }

  async function waitForStatus(id: string, statuses: string[], timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await document(id);
      if (statuses.includes(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`Timed out: document is "${row.status}"`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!, { max: 4 });
    db = createDb(pool);
    storageDir = await mkdtemp(join(tmpdir(), 'sp-worker-'));
    storage = new LocalFileStorage(storageDir);
    queue = new Queue(queueName, {
      connection,
      defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 200 } },
    });
    const [tenant] = await db
      .insert(tenants)
      .values({ name: `Worker ${queueName}`, publicKey: `pk_test_${randomUUID()}` })
      .returning();
    tenantId = tenant!.id;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true)));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
    await pool?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it('processes an uploaded document in the background until it is searchable', async () => {
    const id = await createDocument(
      'warranty.md',
      '# Warranty\nEvery Acme frame has a lifetime warranty.\n\n# Claims\nEmail a photo of the damage.',
    );
    expect((await document(id)).status).toBe('queued');
    startWorker();
    const row = await waitForStatus(id, ['ready', 'failed']);
    expect(row.status).toBe('ready');
    expect(row.error).toBeNull();
    expect(row.chunkCount).toBe(2);

    const [query] = await embeddings.embed(['how long is the frame warranty']);
    const hits = await searchChunks(db, {
      tenantId,
      embedding: query!,
      embeddingModel: embeddings.model,
    });
    expect(hits[0]!.content).toContain('lifetime warranty');
  });

  it('retries a temporary failure and then succeeds', async () => {
    let calls = 0;
    const flaky: EmbeddingProvider = {
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      embed: async (texts) => {
        calls += 1;
        if (calls === 1) throw new Error('Embedding request failed: HTTP 429');
        return embeddings.embed(texts);
      },
    };
    const id = await createDocument('shipping.md', '# Shipping\nWe ship in 3-5 business days.');
    startWorker({ embeddings: flaky });
    const row = await waitForStatus(id, ['ready', 'failed']);
    expect(row.status).toBe('ready');
    expect(calls).toBe(2);
  });

  it('fails a document that has no text, with the reason, without wasting retries', async () => {
    const id = await createDocument('empty.md', '   \n\n ');
    startWorker();
    const row = await waitForStatus(id, ['ready', 'failed']);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/No readable text/);
    // Failed on the first attempt: UnrecoverableError skips the remaining two.
    // The document row is marked failed just before BullMQ moves the job to its failed list,
    // so wait for the job to get there.
    let job: Awaited<ReturnType<typeof queue.getJobs>>[number] | undefined;
    for (let i = 0; i < 50 && !job; i += 1) {
      job = (await queue.getJobs(['failed'])).find((j) => j.data.documentId === id);
      if (!job) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(job?.failedReason).toMatch(/No readable text/);
    expect(job?.attemptsMade ?? 0).toBeLessThanOrEqual(1);
  });

  it('a worker that dies mid-job: the job is picked up again and completes', async () => {
    // Worker A hangs inside the embedding call, then "crashes" (force close, lock not released).
    const hanging: EmbeddingProvider = {
      model: embeddings.model,
      dimensions: embeddings.dimensions,
      embed: () => new Promise<number[][]>(() => undefined),
    };
    const id = await createDocument('sizing.md', '# Sizing\nA 54 cm frame fits riders 170-178 cm.');
    const workerA = startWorker({ embeddings: hanging }, { lockDuration: 1_000 });
    await waitForStatus(id, ['processing']);
    await workerA.close(true);

    // Worker B notices the expired lock (stalled job) and processes it.
    startWorker();
    const row = await waitForStatus(id, ['ready', 'failed']);
    expect(row.status).toBe('ready');
    expect(await listDocumentChunks(db, tenantId, id)).toHaveLength(1);
  });

  it('re-indexing replaces the chunks instead of adding more', async () => {
    const id = await createDocument('faq.md', '# FAQ\nOpen 9-5.\n\n# Contact\nCall us.');
    startWorker();
    await waitForStatus(id, ['ready']);
    expect(await listDocumentChunks(db, tenantId, id)).toHaveLength(2);

    await db.update(documents).set({ status: 'queued' }).where(eq(documents.id, id));
    await queue.add('ingest', { documentId: id, tenantId });
    await waitForStatus(id, ['ready']);
    expect(await listDocumentChunks(db, tenantId, id)).toHaveLength(2);
  });
});
