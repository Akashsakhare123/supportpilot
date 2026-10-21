import { z } from 'zod';

export const DOCUMENT_SOURCE_TYPES = ['pdf', 'text', 'url'] as const;
export type DocumentSourceType = (typeof DOCUMENT_SOURCE_TYPES)[number];

export const DOCUMENT_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Upload limits shared by the API (enforced) and the dashboard (shown, pre-checked). */
export const UPLOAD_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  /** File extension -> source type. */
  extensions: { '.pdf': 'pdf', '.txt': 'text', '.md': 'text', '.markdown': 'text' } as Record<
    string,
    DocumentSourceType
  >,
} as const;

export const addUrlDocumentSchema = z.object({
  url: z.string().trim().url('Enter a full URL, e.g. https://example.com/help').max(2000),
  title: z.string().trim().max(200).optional(),
});
export type AddUrlDocumentInput = z.infer<typeof addUrlDocumentSchema>;

/** A short article written in the dashboard ("Add doc" from the unanswered-questions report). */
export const addTextDocumentSchema = z
  .object({
    title: z.string().trim().min(3, 'Give the article a title').max(200),
    content: z.string().trim().min(20, 'Write at least a sentence or two').max(50_000),
  })
  .strict();
export type AddTextDocumentInput = z.infer<typeof addTextDocumentSchema>;

/** A knowledge-base document as the dashboard lists it. */
export interface DocumentSummary {
  id: string;
  title: string;
  sourceType: DocumentSourceType;
  source: string;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Extension of a file name, lower-cased, with the dot (".pdf"), or "" if none. */
export function fileExtension(name: string): string {
  const match = /\.[a-z0-9]+$/i.exec(name.trim());
  return match ? match[0].toLowerCase() : '';
}
