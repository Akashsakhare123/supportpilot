import { and, asc, cosineDistance, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { documentChunks, documents } from './schema';
import type * as schema from './schema';

type Db = NodePgDatabase<typeof schema>;

export interface NewChunk {
  content: string;
  headingPath: string[];
  tokenCount: number;
  embedding: number[];
}

/**
 * Replace all chunks of a document in one transaction (re-ingesting a document never leaves a
 * mix of old and new chunks) and mark the document ready with its chunk count.
 */
export async function replaceDocumentChunks(
  db: Db,
  input: { tenantId: string; documentId: string; embeddingModel: string; chunks: NewChunk[] },
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .delete(documentChunks)
      .where(
        and(
          eq(documentChunks.tenantId, input.tenantId),
          eq(documentChunks.documentId, input.documentId),
        ),
      );
    // Insert in batches: 1536 floats per row adds up quickly in one statement.
    for (let i = 0; i < input.chunks.length; i += 100) {
      await tx.insert(documentChunks).values(
        input.chunks.slice(i, i + 100).map((chunk, offset) => ({
          tenantId: input.tenantId,
          documentId: input.documentId,
          chunkIndex: i + offset,
          content: chunk.content,
          headingPath: chunk.headingPath,
          tokenCount: chunk.tokenCount,
          embedding: chunk.embedding,
          embeddingModel: input.embeddingModel,
        })),
      );
    }
    const updated = await tx
      .update(documents)
      .set({
        status: 'ready',
        error: null,
        chunkCount: input.chunks.length,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
      .returning({ id: documents.id });
    if (updated.length === 0) throw new Error('Document not found for this tenant');
    return input.chunks.length;
  });
}

export interface ChunkSearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  /** Public page the chunk came from (URL imports only), for "source" links in the widget. */
  documentUrl: string | null;
  content: string;
  headingPath: string[];
  /** Cosine similarity, 1 = identical direction, 0 = unrelated. */
  similarity: number;
}

/**
 * Nearest chunks to a query embedding within ONE tenant. The tenant filter is not optional:
 * this is the only search entry point, so cross-tenant retrieval cannot happen by accident.
 */
export async function searchChunks(
  db: Db,
  input: { tenantId: string; embedding: number[]; embeddingModel: string; limit?: number },
): Promise<ChunkSearchHit[]> {
  if (!input.tenantId) throw new Error('searchChunks requires a tenantId');
  const distance = cosineDistance(documentChunks.embedding, input.embedding);
  return db.transaction(async (tx) => {
    // HNSW returns the global nearest neighbours and the tenant filter is applied afterwards,
    // which can leave a small tenant with too few (or zero) hits. pgvector >= 0.8 iterative
    // scans keep walking the index until enough rows pass the filter.
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
    return tx
      .select({
        chunkId: documentChunks.id,
        documentId: documentChunks.documentId,
        documentTitle: documents.title,
        documentUrl: sql<
          string | null
        >`case when ${documents.sourceType} = 'url' then ${documents.source} else null end`,
        content: documentChunks.content,
        headingPath: documentChunks.headingPath,
        similarity: sql<number>`1 - (${distance})`.mapWith(Number),
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documents.id, documentChunks.documentId))
      .where(
        and(
          eq(documentChunks.tenantId, input.tenantId),
          eq(documentChunks.embeddingModel, input.embeddingModel),
          eq(documents.status, 'ready'),
        ),
      )
      .orderBy(asc(distance))
      .limit(Math.min(Math.max(input.limit ?? 5, 1), 50));
  });
}

/** Chunks of one document in order (dashboard preview, debugging). */
export async function listDocumentChunks(db: Db, tenantId: string, documentId: string) {
  return db
    .select({
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      headingPath: documentChunks.headingPath,
      tokenCount: documentChunks.tokenCount,
    })
    .from(documentChunks)
    .where(and(eq(documentChunks.tenantId, tenantId), eq(documentChunks.documentId, documentId)))
    .orderBy(asc(documentChunks.chunkIndex));
}
