import { describe, expect, it, vi } from 'vitest';
import {
  cosineSimilarity,
  createEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  LocalHashEmbeddings,
  OpenAiEmbeddings,
} from './embeddings';

describe('LocalHashEmbeddings', () => {
  const provider = new LocalHashEmbeddings();

  it('returns deterministic, normalised 1536-d vectors', async () => {
    const [a, b] = await provider.embed(['Lifetime frame warranty', 'Lifetime frame warranty']);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    expect(cosineSimilarity(a!, a!)).toBeCloseTo(1, 6);
  });

  it('ranks the related passage above an unrelated one', async () => {
    const [query, warranty, shipping] = await provider.embed([
      'how long is the frame warranty',
      'Every Acme frame has a lifetime warranty against manufacturing defects.',
      'Orders ship within 3-5 business days by courier.',
    ]);
    expect(cosineSimilarity(query!, warranty!)).toBeGreaterThan(
      cosineSimilarity(query!, shipping!) + 0.2,
    );
  });

  it('gives an all-zero vector for text with no words', async () => {
    const [empty] = await provider.embed(['  ... ']);
    expect(empty!.every((v) => v === 0)).toBe(true);
  });
});

describe('OpenAiEmbeddings', () => {
  const vector = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => seed);

  it('batches requests and keeps input order', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { input } = JSON.parse(String(init!.body)) as { input: string[] };
      // Reply out of order: the client must sort by index.
      const data = input
        .map((text, index) => ({ index, embedding: vector(Number(text)) }))
        .reverse();
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const client = new OpenAiEmbeddings({ apiKey: 'sk-test', batchSize: 2, fetchImpl });
    const result = await client.embed(['1', '2', '3']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.map((v) => v[0])).toEqual([1, 2, 3]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(init!.body))).toMatchObject({
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
  });

  it('retries on 429 and fails fast on 400', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const flaky = vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? new Response('slow down', { status: 429 })
          : new Response(JSON.stringify({ data: [{ index: 0, embedding: vector(7) }] }));
      });
      const pending = new OpenAiEmbeddings({ apiKey: 'k', fetchImpl: flaky }).embed(['x']);
      await vi.runAllTimersAsync();
      expect((await pending)[0]![0]).toBe(7);
      expect(flaky).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    const bad = vi.fn(async () => new Response('bad input', { status: 400 }));
    await expect(
      new OpenAiEmbeddings({ apiKey: 'k', fetchImpl: bad }).embed(['x']),
    ).rejects.toThrow(/HTTP 400/);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe('createEmbeddingProvider', () => {
  it('defaults to the offline provider', () => {
    expect(createEmbeddingProvider({}).model).toBe('local-hash-v2');
    expect(createEmbeddingProvider({ EMBEDDING_PROVIDER: 'mock' }).model).toBe('local-hash-v2');
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'nope' })).toThrow(/Unknown/);
  });

  it('uses OpenAI when configured, and requires a key', () => {
    expect(
      createEmbeddingProvider({ EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }).model,
    ).toBe('text-embedding-3-small');
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'openai' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });
});
