import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, type Database, desc, type DocumentRow, documents, eq } from '@supportpilot/db';
import type {
  AddTextDocumentInput,
  AddUrlDocumentInput,
  DocumentSourceType,
  DocumentStatus,
  DocumentSummary,
} from '@supportpilot/shared';
import { assertPublicUrl, UnsafeUrlError } from '@supportpilot/shared/node';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth.types';
import { DRIZZLE } from '../database/database.module';
import { INGESTION_QUEUE, type IngestionQueue } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { checkUpload, titleFromFileName } from './file-checks';

export function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.sourceType as DocumentSourceType,
    source: row.source,
    status: row.status as DocumentStatus,
    error: row.error,
    chunkCount: row.chunkCount,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Knowledge-base documents. Every query is scoped by the caller's tenant id. */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(INGESTION_QUEUE) private readonly queue: IngestionQueue,
    private readonly storage: StorageService,
  ) {}

  async list(tenantId: string): Promise<DocumentSummary[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(eq(documents.tenantId, tenantId))
      .orderBy(desc(documents.createdAt));
    return rows.map(toSummary);
  }

  /** Validate the bytes, store the file, create the row and queue ingestion. */
  async upload(
    caller: AuthContext,
    file: { originalname: string; buffer: Buffer } | undefined,
    title?: string,
  ): Promise<DocumentSummary> {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    const checked = checkUpload(file.originalname, file.buffer);
    if (typeof checked === 'string') throw new BadRequestException(checked);

    const id = randomUUID();
    const storageKey = `${caller.tenantId}/${id}${checked.extension}`;
    await this.storage.put(storageKey, file.buffer);
    try {
      const [row] = await this.db
        .insert(documents)
        .values({
          id,
          tenantId: caller.tenantId,
          title: title?.trim().slice(0, 200) || titleFromFileName(file.originalname),
          sourceType: checked.sourceType,
          source: file.originalname.slice(0, 255),
          storageKey,
          mimeType: checked.mimeType,
          sizeBytes: file.buffer.length,
          createdBy: caller.userId,
        })
        .returning();
      await this.enqueue(row!);
      return toSummary(row!);
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  /**
   * "Add doc" from the unanswered-questions report: the article becomes a .md upload, so it goes
   * through the same checks, storage and ingestion as any uploaded file.
   */
  async addText(caller: AuthContext, input: AddTextDocumentInput): Promise<DocumentSummary> {
    const slug =
      input.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'article';
    const markdown = `# ${input.title}\n\n${input.content}\n`;
    return this.upload(
      caller,
      { originalname: `${slug}.md`, buffer: Buffer.from(markdown) },
      input.title,
    );
  }

  /** Queue a public web page for import. The worker re-checks the URL before fetching it. */
  async addUrl(caller: AuthContext, input: AddUrlDocumentInput): Promise<DocumentSummary> {
    let url: URL;
    try {
      url = await assertPublicUrl(input.url);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new BadRequestException(error.message);
      throw error;
    }
    const [row] = await this.db
      .insert(documents)
      .values({
        tenantId: caller.tenantId,
        title:
          input.title || `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 200),
        sourceType: 'url',
        source: url.href,
        createdBy: caller.userId,
      })
      .returning();
    await this.enqueue(row!);
    return toSummary(row!);
  }

  /** Re-run ingestion (e.g. after a failure or when the source changed). */
  async reindex(tenantId: string, id: string): Promise<DocumentSummary> {
    await this.find(tenantId, id);
    const [row] = await this.db
      .update(documents)
      .set({ status: 'queued', error: null, updatedAt: new Date() })
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
      .returning();
    await this.enqueue(row!);
    return toSummary(row!);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const row = await this.find(tenantId, id);
    await this.db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)));
    if (row.storageKey) await this.storage.delete(row.storageKey).catch(() => undefined);
  }

  private async find(tenantId: string, id: string): Promise<DocumentRow> {
    const row = await this.db.query.documents.findFirst({
      where: and(eq(documents.id, id), eq(documents.tenantId, tenantId)),
    });
    // 404 (not 403) for other tenants' ids, so ids do not leak across tenants.
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  private async enqueue(row: DocumentRow): Promise<void> {
    await this.queue.add('ingest', { documentId: row.id, tenantId: row.tenantId });
    this.logger.log(`Queued ingestion for document ${row.id} (${row.sourceType})`);
  }
}
