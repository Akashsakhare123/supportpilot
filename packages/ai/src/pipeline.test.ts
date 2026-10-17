import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cosineSimilarity, LocalHashEmbeddings, type EmbeddingProvider } from './embeddings';
import { extractPdfText } from './extract';
import { embedDocument } from './pipeline';

const handbook = () =>
  readFileSync(new URL('../test/fixtures/handbook-20-pages.pdf', import.meta.url));

describe('embedDocument', () => {
  const provider = new LocalHashEmbeddings();

  it('turns a 20-page PDF into embedded chunks and finds a known phrase in the top 3', async () => {
    const text = await extractPdfText(handbook());
    for (const page of [1, 7, 20]) expect(text).toContain(`Page ${page}:`);

    const doc = await embedDocument('Acme e-bike handbook', text, provider, { maxTokens: 150 });
    expect(doc.model).toBe('local-hash-v2');
    expect(doc.chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of doc.chunks) expect(chunk.embedding).toHaveLength(1536);

    const [query] = await provider.embed(['What does error E07 mean?']);
    const top3 = doc.chunks
      .map((chunk) => ({ chunk, score: cosineSimilarity(query!, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    expect(top3.some(({ chunk }) => chunk.content.includes('E07'))).toBe(true);
  });

  it('returns no chunks (and makes no API call) for empty text', async () => {
    let calls = 0;
    const counting: EmbeddingProvider = {
      model: 'counting',
      dimensions: 1536,
      embed: async (texts) => {
        calls += 1;
        return texts.map(() => []);
      },
    };
    expect(await embedDocument('Empty', '  ', counting)).toEqual({ model: 'counting', chunks: [] });
    expect(calls).toBe(0);
  });

  it('fails loudly if the provider returns the wrong number of vectors', async () => {
    const broken: EmbeddingProvider = { model: 'broken', dimensions: 1536, embed: async () => [] };
    await expect(embedDocument('Doc', 'Some text', broken)).rejects.toThrow(
      /0 vectors for 1 chunks/,
    );
  });
});
