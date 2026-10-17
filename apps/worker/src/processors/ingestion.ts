import {
  embedDocument,
  extractPdfText,
  FetchPageError,
  fetchPublicPage,
  type EmbeddedChunk,
  type EmbeddingProvider,
  type ExtractedText,
} from '@supportpilot/ai';
import {
  ingestionJobSchema,
  type DocumentStatusEvent,
  type IngestionJob,
} from '@supportpilot/shared';
import { UnsafeUrlError } from '@supportpilot/shared/node';
import { UnrecoverableError } from 'bullmq';

/** The fields of a document row the pipeline needs. */
export interface IngestDocument {
  id: string;
  tenantId: string;
  title: string;
  sourceType: 'pdf' | 'text' | 'url';
  source: string;
  storageKey: string | null;
}

/** Database access used by the pipeline (Postgres in production, an in-memory fake in tests). */
export interface DocumentRepository {
  find(tenantId: string, documentId: string): Promise<IngestDocument | null>;
  setStatus(
    tenantId: string,
    documentId: string,
    status: 'queued' | 'processing' | 'failed',
    error: string | null,
  ): Promise<void>;
  /** Replace the document's chunks and mark it ready, atomically. Returns the chunk count. */
  saveChunks(
    tenantId: string,
    documentId: string,
    embeddingModel: string,
    chunks: EmbeddedChunk[],
  ): Promise<number>;
}

export interface IngestionDeps {
  repo: DocumentRepository;
  storage: { get(key: string): Promise<Buffer> };
  embeddings: EmbeddingProvider;
  fetchPage?: (url: string) => Promise<ExtractedText>;
  extractPdf?: (data: Uint8Array) => Promise<string>;
  /** Status change notifications (Redis pub/sub in production). Failures here never fail a job. */
  publish?: (event: DocumentStatusEvent) => Promise<unknown> | void;
  log?: (message: string) => void;
}

/** The parts of a BullMQ job the processor reads (keeps tests free of Redis). */
export interface JobLike {
  data: unknown;
  /** Attempts that already failed before this one. */
  attemptsMade: number;
  opts: { attempts?: number };
}

export interface IngestionResult {
  documentId: string;
  status: 'ready' | 'skipped';
  chunks: number;
}

/** Limits that keep one huge upload from monopolising the embedding budget. */
export const INGESTION_LIMITS = {
  maxChunks: 2_000,
} as const;

/** A problem with the document itself: retrying cannot help, so the job fails immediately. */
export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionError';
  }
}

function isPermanent(error: unknown): boolean {
  if (error instanceof IngestionError || error instanceof UnsafeUrlError) return true;
  if ((error as { name?: string } | null)?.name === 'UnsafeUrlError') return true;
  if (error instanceof FetchPageError) return !error.retryable;
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOENT') return true; // uploaded file is gone
  const name = (error as { name?: string } | null)?.name ?? '';
  return /InvalidPDF|PasswordException|FormatError/.test(name);
}

function explain(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOENT') return 'The uploaded file is missing from storage. Upload it again.';
  const name = (error as { name?: string } | null)?.name ?? '';
  if (/PasswordException/.test(name)) return 'The PDF is password protected.';
  if (/InvalidPDF|FormatError/.test(name)) return 'The PDF file is damaged or not a real PDF.';
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500) || 'Unknown error';
}

async function loadText(doc: IngestDocument, deps: IngestionDeps): Promise<string> {
  switch (doc.sourceType) {
    case 'url': {
      const page = await (deps.fetchPage ?? ((url: string) => fetchPublicPage(url)))(doc.source);
      return page.text;
    }
    case 'pdf': {
      if (!doc.storageKey) throw new IngestionError('The document has no stored file.');
      const bytes = await deps.storage.get(doc.storageKey);
      return (deps.extractPdf ?? extractPdfText)(bytes);
    }
    case 'text': {
      if (!doc.storageKey) throw new IngestionError('The document has no stored file.');
      const bytes = await deps.storage.get(doc.storageKey);
      return bytes.toString('utf8').replace(/^\uFEFF/, '');
    }
    default:
      throw new IngestionError(`Unsupported source type: ${String(doc.sourceType)}`);
  }
}

/**
 * Ingestion job: load the source -> extract text -> chunk -> embed -> replace the chunks.
 * Status goes queued -> processing -> ready. On a temporary error the job is retried by BullMQ
 * (document back to "queued" with the reason); on the last attempt, or for a problem retrying
 * cannot fix, the document becomes "failed" with a readable reason.
 */
export async function processIngestion(
  job: JobLike,
  deps: IngestionDeps,
): Promise<IngestionResult> {
  const { documentId, tenantId }: IngestionJob = ingestionJobSchema.parse(job.data);
  const log = deps.log ?? (() => undefined);
  const notify = async (event: Omit<DocumentStatusEvent, 'tenantId' | 'documentId'>) => {
    try {
      await deps.publish?.({ tenantId, documentId, ...event });
    } catch (error) {
      log(`could not publish status for ${documentId}: ${explain(error)}`);
    }
  };

  const doc = await deps.repo.find(tenantId, documentId);
  if (!doc) {
    log(`document ${documentId} no longer exists, skipping`);
    return { documentId, status: 'skipped', chunks: 0 };
  }

  try {
    await deps.repo.setStatus(tenantId, documentId, 'processing', null);
    await notify({ status: 'processing', error: null, chunkCount: 0 });

    const text = await loadText(doc, deps);
    if (!text.trim()) {
      throw new IngestionError(
        doc.sourceType === 'pdf'
          ? 'No text found in the PDF (scanned images are not supported yet).'
          : 'No readable text found.',
      );
    }
    const embedded = await embedDocument(doc.title, text, deps.embeddings);
    if (embedded.chunks.length === 0) throw new IngestionError('No readable text found.');
    if (embedded.chunks.length > INGESTION_LIMITS.maxChunks) {
      throw new IngestionError(
        `The document is too large (${embedded.chunks.length} chunks, limit ${INGESTION_LIMITS.maxChunks}). Split it into smaller files.`,
      );
    }
    const chunks = await deps.repo.saveChunks(
      tenantId,
      documentId,
      embedded.model,
      embedded.chunks,
    );
    await notify({ status: 'ready', error: null, chunkCount: chunks });
    log(`document ${documentId} ready: ${chunks} chunks (${embedded.model})`);
    return { documentId, status: 'ready', chunks };
  } catch (error) {
    // Deleted while we were working on it: nothing to report.
    if (!(await deps.repo.find(tenantId, documentId).catch(() => doc))) {
      return { documentId, status: 'skipped', chunks: 0 };
    }
    const maxAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;
    const permanent = isPermanent(error);
    const reason = explain(error);
    if (permanent || attempt >= maxAttempts) {
      await deps.repo.setStatus(tenantId, documentId, 'failed', reason);
      await notify({ status: 'failed', error: reason, chunkCount: 0 });
    } else {
      const retryNote = `Attempt ${attempt} of ${maxAttempts} failed: ${reason.replace(/\.?$/, '.')} Retrying automatically.`;
      await deps.repo.setStatus(tenantId, documentId, 'queued', retryNote);
      await notify({ status: 'queued', error: retryNote, chunkCount: 0 });
    }
    // UnrecoverableError tells BullMQ to skip the remaining attempts.
    if (permanent) throw new UnrecoverableError(reason);
    throw error;
  }
}
