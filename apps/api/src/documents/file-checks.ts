import { type DocumentSourceType, fileExtension, UPLOAD_LIMITS } from '@supportpilot/shared';

export interface CheckedFile {
  sourceType: DocumentSourceType;
  extension: string;
  mimeType: string;
}

/**
 * Decide what an uploaded file is from its name AND its bytes (never trust the browser's
 * Content-Type). Returns an error message when the file is not acceptable.
 */
export function checkUpload(originalName: string, data: Buffer): CheckedFile | string {
  const extension = fileExtension(originalName);
  const sourceType = UPLOAD_LIMITS.extensions[extension];
  if (!sourceType) return 'Only PDF, .txt and .md files are supported';
  if (data.length === 0) return 'The file is empty';
  if (data.length > UPLOAD_LIMITS.maxBytes) return 'Files can be at most 10 MB';

  if (sourceType === 'pdf') {
    if (data.subarray(0, 5).toString('latin1') !== '%PDF-') return 'This is not a valid PDF file';
    return { sourceType, extension, mimeType: 'application/pdf' };
  }
  // Text / markdown: must be UTF-8 text, not a renamed binary.
  if (data.includes(0)) return 'This does not look like a text file';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return 'Text files must be UTF-8 encoded';
  }
  return { sourceType, extension, mimeType: extension === '.txt' ? 'text/plain' : 'text/markdown' };
}

/** "shipping_and-returns.md" -> "shipping and returns". */
export function titleFromFileName(name: string): string {
  const base = name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return (base || 'Untitled document').slice(0, 200);
}
