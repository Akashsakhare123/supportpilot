/** Rough token estimate (~4 characters per token for English). Good enough for sizing chunks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  index: number;
  content: string;
  /** Markdown heading trail the chunk sits under, e.g. ["Warranty", "How to make a claim"]. */
  headingPath: string[];
  tokenCount: number;
}

export interface ChunkOptions {
  /** Target maximum size of a chunk. */
  maxTokens?: number;
  /** How much of the previous chunk (same section) is repeated at the start of the next one. */
  overlapTokens?: number;
}

interface Section {
  headingPath: string[];
  paragraphs: string[];
}

/** Split text into sections at markdown headings, and sections into paragraphs. */
function toSections(text: string): Section[] {
  const sections: Section[] = [];
  let path: string[] = [];
  let current: Section = { headingPath: [], paragraphs: [] };
  let buffer: string[] = [];

  const flushParagraph = () => {
    const paragraph = buffer.join('\n').trim();
    if (paragraph) current.paragraphs.push(paragraph);
    buffer = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (current.paragraphs.length > 0) sections.push(current);
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushSection();
      const level = heading[1]!.length;
      path = [...path.slice(0, level - 1), heading[2]!.trim()];
      current = { headingPath: path, paragraphs: [] };
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      buffer.push(line);
    }
  }
  flushSection();
  return sections;
}

/** Break a paragraph that alone exceeds the limit at sentence boundaries, then at spaces. */
function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const pieces: string[] = [];
  let current = '';
  const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [paragraph];
  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars && current) {
      pieces.push(current.trim());
      current = '';
    }
    if (sentence.length > maxChars) {
      for (let i = 0; i < sentence.length; i += maxChars)
        pieces.push(sentence.slice(i, i + maxChars).trim());
    } else {
      current += sentence;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces.filter(Boolean);
}

/**
 * Markdown-aware chunker: never mixes two sections in one chunk, packs paragraphs up to
 * `maxTokens`, and repeats the tail of the previous chunk (up to `overlapTokens`) so an answer
 * spanning a chunk boundary is still retrievable.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = (options.maxTokens ?? 700) * 4;
  const overlapChars = (options.overlapTokens ?? 100) * 4;
  const chunks: Chunk[] = [];

  for (const section of toSections(text)) {
    const paragraphs = section.paragraphs.flatMap((p) => splitLong(p, maxChars));
    let current: string[] = [];
    let size = 0;

    const emit = () => {
      if (current.length === 0) return;
      const content = current.join('\n\n');
      chunks.push({
        index: chunks.length,
        content,
        headingPath: section.headingPath,
        tokenCount: estimateTokens(content),
      });
      // Carry the last paragraphs (up to the overlap budget) into the next chunk.
      const tail: string[] = [];
      let tailSize = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const p = current[i]!;
        if (tailSize + p.length > overlapChars) break;
        tail.unshift(p);
        tailSize += p.length;
      }
      current = tail;
      size = tailSize;
    };

    let sinceEmit = 0;
    for (const paragraph of paragraphs) {
      if (size + paragraph.length > maxChars && sinceEmit > 0) {
        emit();
        sinceEmit = 0;
      }
      current.push(paragraph);
      size += paragraph.length + 2;
      sinceEmit += 1;
    }
    if (sinceEmit > 0) emit();
  }
  return chunks;
}

/** The text that is embedded for a chunk: document title and heading trail add context. */
export function chunkEmbeddingText(
  title: string,
  chunk: Pick<Chunk, 'headingPath' | 'content'>,
): string {
  const trail = chunk.headingPath.length ? `\n${chunk.headingPath.join(' > ')}` : '';
  return `${title}${trail}\n\n${chunk.content}`;
}
