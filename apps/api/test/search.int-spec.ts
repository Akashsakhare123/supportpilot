import { readFileSync } from 'node:fs';
import path from 'node:path';
import { embedDocument, LocalHashEmbeddings } from '@supportpilot/ai';
import {
  createDb,
  createPool,
  documentChunks,
  documents,
  eq,
  listDocumentChunks,
  replaceDocumentChunks,
  searchChunks,
  type Database,
  type Pool,
} from '@supportpilot/db';
import { createTestTenant, type TestTenant } from './helpers';

const SEED_DIR = path.resolve(__dirname, '../../../packages/db/seed-data/acme-bikes');
const embeddings = new LocalHashEmbeddings();

describe('Chunking, embeddings and tenant-scoped vector search (T05)', () => {
  let pool: Pool;
  let db: Database;
  let acme: TestTenant;
  let other: TestTenant;

  /** Chunk + embed a markdown article and store it as a ready document for the tenant. */
  async function ingest(tenantId: string, file: string, title: string): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({ tenantId, title, sourceType: 'text', source: file, status: 'processing' })
      .returning();
    const embedded = await embedDocument(
      title,
      readFileSync(path.join(SEED_DIR, file), 'utf8'),
      embeddings,
    );
    await replaceDocumentChunks(db, {
      tenantId,
      documentId: doc!.id,
      embeddingModel: embedded.model,
      chunks: embedded.chunks,
    });
    return doc!.id;
  }

  async function search(tenantId: string, question: string, limit = 3) {
    const [embedding] = await embeddings.embed([question]);
    return searchChunks(db, {
      tenantId,
      embedding: embedding!,
      embeddingModel: embeddings.model,
      limit,
    });
  }

  let warrantyId: string;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    acme = await createTestTenant('Search');
    other = await createTestTenant('OtherSearch');
    warrantyId = await ingest(acme.tenantId, 'warranty.md', 'Warranty');
    await ingest(acme.tenantId, 'shipping-and-returns.md', 'Shipping and returns');
    await ingest(acme.tenantId, 'sizing-guide.md', 'Sizing guide');
    // The other tenant has a document saying something different about warranties.
    const [otherDoc] = await db
      .insert(documents)
      .values({
        tenantId: other.tenantId,
        title: 'Other warranty',
        sourceType: 'text',
        source: 'x.md',
      })
      .returning();
    const [vec] = await embeddings.embed(['Frame warranty is 1 year only at Other Co.']);
    await replaceDocumentChunks(db, {
      tenantId: other.tenantId,
      documentId: otherDoc!.id,
      embeddingModel: embeddings.model,
      chunks: [
        {
          content: 'Frame warranty is 1 year only at Other Co.',
          headingPath: [],
          tokenCount: 10,
          embedding: vec!,
        },
      ],
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('stores chunks in order and marks the document ready with its chunk count', async () => {
    const [doc] = await db.select().from(documents).where(eq(documents.id, warrantyId));
    const chunks = await listDocumentChunks(db, acme.tenantId, warrantyId);
    expect(doc!.status).toBe('ready');
    expect(doc!.chunkCount).toBe(chunks.length);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0]!.headingPath[0]).toBe('Warranty');
  });

  it('finds the warranty passage for a warranty question', async () => {
    const hits = await search(acme.tenantId, 'How long is the frame warranty?');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.documentTitle).toBe('Warranty');
    expect(hits.map((h) => h.content).join('\n')).toMatch(/lifetime warranty/);
    expect(hits[0]!.similarity).toBeGreaterThan(0.1);
    // Ordered best first.
    const sims = hits.map((h) => h.similarity);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
  });

  it('finds shipping content for a shipping question', async () => {
    const hits = await search(acme.tenantId, 'How many days does shipping take?');
    expect(hits[0]!.documentTitle).toBe('Shipping and returns');
  });

  it('never returns another tenant’s chunks', async () => {
    const acmeHits = await search(acme.tenantId, 'Frame warranty 1 year Other Co', 10);
    expect(acmeHits.every((h) => !h.content.includes('Other Co'))).toBe(true);

    const otherHits = await search(other.tenantId, 'How long is the frame warranty?', 10);
    expect(otherHits).toHaveLength(1);
    expect(otherHits[0]!.content).toContain('Other Co');
  });

  it('ignores vectors made by a different embedding model', async () => {
    const [embedding] = await embeddings.embed(['frame warranty']);
    const hits = await searchChunks(db, {
      tenantId: acme.tenantId,
      embedding: embedding!,
      embeddingModel: 'some-other-model',
    });
    expect(hits).toEqual([]);
  });

  it('re-ingesting replaces chunks instead of duplicating them', async () => {
    const before = await listDocumentChunks(db, acme.tenantId, warrantyId);
    const [vec] = await embeddings.embed(['Warranty v2: frames are covered for 10 years.']);
    await replaceDocumentChunks(db, {
      tenantId: acme.tenantId,
      documentId: warrantyId,
      embeddingModel: embeddings.model,
      chunks: [
        {
          content: 'Warranty v2: frames are covered for 10 years.',
          headingPath: ['Warranty'],
          tokenCount: 12,
          embedding: vec!,
        },
      ],
    });
    const after = await listDocumentChunks(db, acme.tenantId, warrantyId);
    expect(before.length).toBeGreaterThan(1);
    expect(after).toHaveLength(1);
    const [doc] = await db.select().from(documents).where(eq(documents.id, warrantyId));
    expect(doc!.chunkCount).toBe(1);
  });

  it('refuses to write chunks for a document of another tenant', async () => {
    const [vec] = await embeddings.embed(['x']);
    await expect(
      replaceDocumentChunks(db, {
        tenantId: other.tenantId,
        documentId: warrantyId,
        embeddingModel: embeddings.model,
        chunks: [{ content: 'x', headingPath: [], tokenCount: 1, embedding: vec! }],
      }),
    ).rejects.toThrow();
    // Transaction rolled back: nothing was written for the other tenant.
    const leaked = await db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.documentId, warrantyId));
    expect(leaked.every((c) => c.tenantId === acme.tenantId)).toBe(true);
  });

  it('deleting a document removes its chunks (cascade)', async () => {
    await db.delete(documents).where(eq(documents.id, warrantyId));
    expect(await listDocumentChunks(db, acme.tenantId, warrantyId)).toEqual([]);
  });
});
