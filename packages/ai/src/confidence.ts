import type { AnswerMeta } from './prompt';

/**
 * Similarity range that means "unrelated" (floor) to "clearly about this" (ceiling) for each
 * embedding model. Cosine values are not comparable across models, so they are rescaled to 0-1
 * before blending. Tuned on the demo knowledge base; re-tuned with the eval set in T14.
 */
export const RETRIEVAL_CALIBRATION: Record<string, { floor: number; ceiling: number }> = {
  'local-hash-v2': { floor: 0.08, ceiling: 0.4 },
  'text-embedding-3-small': { floor: 0.2, ceiling: 0.55 },
  'text-embedding-3-large': { floor: 0.15, ceiling: 0.5 },
};
const DEFAULT_CALIBRATION = { floor: 0.2, ceiling: 0.6 };

export function calibrationFor(embeddingModel: string): { floor: number; ceiling: number } {
  return RETRIEVAL_CALIBRATION[embeddingModel] ?? DEFAULT_CALIBRATION;
}

/** Cosine similarity rescaled to 0-1 for the model ("how relevant is this passage"). */
export function retrievalScore(similarity: number, embeddingModel: string): number {
  const { floor, ceiling } = calibrationFor(embeddingModel);
  return Math.min(1, Math.max(0, (similarity - floor) / (ceiling - floor)));
}

export interface ConfidenceInput {
  /** Raw similarities of the passages the answer cites (or of all passages if none were cited). */
  similarities: number[];
  embeddingModel: string;
  meta: AnswerMeta | null;
}

/**
 * confidence = 0.6 * retrieval + 0.4 * self, 0 when the model says the context had no answer.
 * retrieval = mean calibrated similarity of the cited passages; self = the model's own rating
 * (0.5 when the model gave no metadata).
 */
export function scoreConfidence(input: ConfidenceInput): number {
  if (input.meta && !input.meta.answered) return 0;
  if (input.similarities.length === 0) return 0;
  const retrieval =
    input.similarities.reduce((sum, s) => sum + retrievalScore(s, input.embeddingModel), 0) /
    input.similarities.length;
  const self = input.meta?.confidence ?? 0.5;
  return Math.round((0.6 * retrieval + 0.4 * self) * 100) / 100;
}

/** "Can I talk to a person?" in its common forms. */
export function asksForHuman(message: string): boolean {
  return (
    /\b(talk|speak|chat|connect|transfer)\b[^.?!]{0,40}\b(human|person|agent|someone|somebody|representative|staff|people)\b/i.test(
      message,
    ) ||
    /\b(real|live)\s+(person|human|agent)\b/i.test(message) ||
    /^\s*(human|agent|operator)\s*[.!?]*\s*$/i.test(message)
  );
}
