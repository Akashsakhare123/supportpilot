import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const documentSourceType = pgEnum('document_source_type', ['pdf', 'text', 'url']);
export const documentStatus = pgEnum('document_status', [
  'queued',
  'processing',
  'ready',
  'failed',
]);

/** Knowledge-base items. Content is chunked and embedded by the ingestion worker (T05-T06). */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sourceType: documentSourceType('source_type').notNull(),
    /** Original file name, or the URL for URL imports. */
    source: text('source').notNull(),
    /** Key in the StorageService for uploaded files (null for URLs). */
    storageKey: text('storage_key'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    status: documentStatus('status').notNull().default('queued'),
    error: text('error'),
    chunkCount: integer('chunk_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_tenant_id_idx').on(t.tenantId)],
);

export type DocumentRow = typeof documents.$inferSelect;
