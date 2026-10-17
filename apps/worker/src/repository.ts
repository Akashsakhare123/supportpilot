import { and, documents, eq, replaceDocumentChunks, type Database } from '@supportpilot/db';
import type { DocumentRepository } from './processors/ingestion';

/** DocumentRepository on Postgres. Every query is scoped by tenant id. */
export function createDocumentRepository(db: Database): DocumentRepository {
  return {
    async find(tenantId, documentId) {
      const row = await db.query.documents.findFirst({
        where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
        columns: {
          id: true,
          tenantId: true,
          title: true,
          sourceType: true,
          source: true,
          storageKey: true,
        },
      });
      return row ?? null;
    },

    async setStatus(tenantId, documentId, status, error) {
      await db
        .update(documents)
        .set({ status, error, updatedAt: new Date() })
        .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
    },

    saveChunks(tenantId, documentId, embeddingModel, chunks) {
      return replaceDocumentChunks(db, { tenantId, documentId, embeddingModel, chunks });
    },
  };
}
