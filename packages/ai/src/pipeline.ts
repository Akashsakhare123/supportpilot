import { chunkEmbeddingText, chunkText, type Chunk, type ChunkOptions } from './chunk';
import type { EmbeddingProvider } from './embeddings';

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface EmbeddedDocument {
  /** Model that produced the vectors; stored with every chunk. */
  model: string;
  chunks: EmbeddedChunk[];
}

/** Text -> chunks -> embeddings. The ingestion worker (T06) stores the result. */
export async function embedDocument(
  title: string,
  text: string,
  provider: EmbeddingProvider,
  options: ChunkOptions = {},
): Promise<EmbeddedDocument> {
  const chunks = chunkText(text, options);
  if (chunks.length === 0) return { model: provider.model, chunks: [] };
  const vectors = await provider.embed(chunks.map((chunk) => chunkEmbeddingText(title, chunk)));
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vectors for ${chunks.length} chunks`,
    );
  }
  return {
    model: provider.model,
    chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i]! })),
  };
}
