import { index, integer, jsonb, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';
import { documents } from './documents';
import { tenants } from './tenants';

/** Must match EMBEDDING_DIMENSIONS in @supportpilot/ai. */
export const VECTOR_DIMENSIONS = 1536;

/**
 * Retrieval units: a piece of a document plus its embedding. tenant_id is copied from the
 * document so every vector search can (and must) filter by tenant without a join.
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    /** Markdown heading trail, e.g. ["Warranty", "Claims"]; shown as the citation location. */
    headingPath: jsonb('heading_path').$type<string[]>().notNull().default([]),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: VECTOR_DIMENSIONS }).notNull(),
    /** Which model produced the vector; searches only compare vectors of the same model. */
    embeddingModel: text('embedding_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('document_chunks_tenant_id_idx').on(t.tenantId),
    index('document_chunks_document_id_idx').on(t.documentId, t.chunkIndex),
    index('document_chunks_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export type DocumentChunkRow = typeof documentChunks.$inferSelect;
