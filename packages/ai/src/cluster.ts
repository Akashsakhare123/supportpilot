import { cosineSimilarity, type EmbeddingProvider } from './embeddings';

/**
 * Cosine similarity above which two customer questions count as "the same question" for each
 * embedding model. The offline model is lexical, so rewordings share fewer features and need a
 * lower bar; real models put paraphrases close together.
 */
export const QUESTION_GROUP_THRESHOLD: Record<string, number> = {
  'local-hash-v2': 0.42,
  'text-embedding-3-small': 0.7,
  'text-embedding-3-large': 0.65,
};
const DEFAULT_GROUP_THRESHOLD = 0.7;

export function groupThresholdFor(embeddingModel: string): number {
  return QUESTION_GROUP_THRESHOLD[embeddingModel] ?? DEFAULT_GROUP_THRESHOLD;
}

/** Same text for grouping: lower case, single spaces, no trailing punctuation. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s?!.,;:]+$/, '')
    .trim();
}

export interface GroupInput<T> {
  text: string;
  /** How often this exact text was asked (identical texts are merged before embedding). */
  weight: number;
  vector: number[];
  item: T;
}

export interface Group<T> {
  /** The most-asked text in the group, shown as its label. */
  label: string;
  weight: number;
  members: GroupInput<T>[];
}

function normalized(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

/**
 * Greedy "leader" clustering: most-asked texts first; each text joins the group whose centroid
 * is most similar (at least `threshold`), otherwise it starts a new group. Deterministic and
 * O(texts x groups), which is plenty for the few hundred questions in a report.
 */
export function groupBySimilarity<T>(inputs: GroupInput<T>[], threshold: number): Group<T>[] {
  const sorted = [...inputs].sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  const groups: (Group<T> & { sum: number[]; centroid: number[] })[] = [];
  for (const input of sorted) {
    let best: (typeof groups)[number] | null = null;
    let bestScore = threshold;
    for (const group of groups) {
      const score = cosineSimilarity(group.centroid, input.vector);
      if (score >= bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (best) {
      best.members.push(input);
      best.weight += input.weight;
      best.sum = best.sum.map((v, i) => v + (input.vector[i] ?? 0) * input.weight);
      best.centroid = normalized(best.sum);
    } else {
      const sum = input.vector.map((v) => v * input.weight);
      groups.push({
        label: input.text,
        weight: input.weight,
        members: [input],
        sum,
        centroid: normalized(sum),
      });
    }
  }
  return groups
    .map(({ label, weight, members }) => ({ label, weight, members }))
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
}

/** Embed each distinct question text once (in batches). Keys are normalizeQuestion() texts. */
export async function embedQuestions(
  texts: string[],
  embeddings: EmbeddingProvider,
  batchSize = 128,
): Promise<Map<string, number[]>> {
  const distinct = [...new Set(texts.map(normalizeQuestion).filter(Boolean))];
  const vectors = new Map<string, number[]>();
  for (let i = 0; i < distinct.length; i += batchSize) {
    const batch = distinct.slice(i, i + batchSize);
    const embedded = await embeddings.embed(batch);
    batch.forEach((text, j) => vectors.set(text, embedded[j]!));
  }
  return vectors;
}

/**
 * Group questions by meaning: identical texts (after normalizeQuestion) are merged, then the
 * distinct texts are clustered with their vectors from embedQuestions(). Items keep their data;
 * the group label is the original wording of the first item of the most-asked text.
 */
export function groupEmbeddedQuestions<T extends { text: string }>(
  items: T[],
  vectors: Map<string, number[]>,
  threshold: number,
): Group<T[]>[] {
  const byText = new Map<string, T[]>();
  for (const item of items) {
    const key = normalizeQuestion(item.text);
    if (!key || !vectors.has(key)) continue;
    const list = byText.get(key);
    if (list) list.push(item);
    else byText.set(key, [item]);
  }
  const inputs = [...byText.entries()].map(([key, list]) => ({
    text: list[0]!.text.trim(),
    weight: list.length,
    vector: vectors.get(key)!,
    item: list,
  }));
  return groupBySimilarity(inputs, threshold);
}

/** embedQuestions() + groupEmbeddedQuestions() with the model's threshold. */
export async function groupQuestions<T extends { text: string }>(
  items: T[],
  embeddings: EmbeddingProvider,
  options: { threshold?: number; batchSize?: number } = {},
): Promise<Group<T[]>[]> {
  const vectors = await embedQuestions(
    items.map((item) => item.text),
    embeddings,
    options.batchSize,
  );
  return groupEmbeddedQuestions(
    items,
    vectors,
    options.threshold ?? groupThresholdFor(embeddings.model),
  );
}
