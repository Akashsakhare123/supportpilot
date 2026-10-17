/** Dimension of every stored embedding (matches OpenAI text-embedding-3-small and the vector column). */
export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  /** Stored next to each vector, so vectors from different models are never compared. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from has have how i if in is it its me my of on or our so that the their them then there these this to us was we what when where which who why will with you your'.split(
    ' ',
  ),
);

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Very light stemming so "returns" / "returned" / "return" share a feature. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1') || word;
}

/**
 * Offline embeddings: feature-hashed words + word pairs, L2-normalised. No API key, deterministic,
 * free. Purely lexical (no synonyms), so it is for local development, tests and CI; use a real
 * model (EMBEDDING_PROVIDER=openai) for meaning-based search.
 */
export class LocalHashEmbeddings implements EmbeddingProvider {
  readonly model = 'local-hash-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter((w) => !STOPWORDS.has(w))
        .map(stem);
      const add = (feature: string, weight: number) => {
        const h = fnv1a(feature);
        vector[h % this.dimensions]! += h & 0x80000000 ? -weight : weight;
      };
      words.forEach((word, i) => {
        add(word, 1);
        if (i > 0) add(`${words[i - 1]} ${word}`, 0.5);
      });
      return normalize(vector);
    });
  }
}

export interface OpenAiEmbeddingsOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  batchSize?: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

/** OpenAI-compatible /v1/embeddings client with batching and retry on 429 / 5xx. */
export class OpenAiEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(private readonly options: OpenAiEmbeddingsOptions) {
    this.model = options.model ?? 'text-embedding-3-small';
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 96;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + batchSize))));
    }
    return out;
  }

  private async embedBatch(input: string[]): Promise<number[][]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const maxRetries = this.options.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(
        `${this.options.baseUrl ?? 'https://api.openai.com'}/v1/embeddings`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: this.model, input, dimensions: this.dimensions }),
        },
      );
      if (res.ok) {
        const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(
          `Embedding request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
    }
  }
}

/**
 * Pick the provider from env: EMBEDDING_PROVIDER=local (default; `mock` is an alias used by CI)
 * or openai (needs OPENAI_API_KEY; optional EMBEDDING_MODEL and OPENAI_BASE_URL).
 */
export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = (env.EMBEDDING_PROVIDER || 'local').toLowerCase();
  if (provider === 'local' || provider === 'mock') return new LocalHashEmbeddings();
  if (provider === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('EMBEDDING_PROVIDER=openai needs OPENAI_API_KEY');
    return new OpenAiEmbeddings({
      apiKey: env.OPENAI_API_KEY,
      model: env.EMBEDDING_MODEL || undefined,
      baseUrl: env.OPENAI_BASE_URL || undefined,
    });
  }
  throw new Error(`Unknown EMBEDDING_PROVIDER "${provider}" (use local or openai)`);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * (b[i] ?? 0);
  return dot;
}
