import { describe, expect, it } from 'vitest';
import { asksForHuman, retrievalScore, scoreConfidence } from './confidence';

describe('scoreConfidence', () => {
  const model = 'text-embedding-3-small'; // calibration 0.2 - 0.55

  it('blends calibrated retrieval (60%) with the model self-rating (40%)', () => {
    expect(
      scoreConfidence({
        similarities: [0.55],
        embeddingModel: model,
        meta: { answered: true, confidence: 1, sources: [1] },
      }),
    ).toBe(1);
    expect(
      scoreConfidence({
        similarities: [0.375],
        embeddingModel: model,
        meta: { answered: true, confidence: 0.5, sources: [1] },
      }),
    ).toBe(0.5);
  });

  it('is 0 when the model says the answer is not in the context, or nothing was retrieved', () => {
    expect(
      scoreConfidence({
        similarities: [0.6],
        embeddingModel: model,
        meta: { answered: false, confidence: 0.9, sources: [] },
      }),
    ).toBe(0);
    expect(scoreConfidence({ similarities: [], embeddingModel: model, meta: null })).toBe(0);
  });

  it('uses 0.5 as the self-rating when the model gave no metadata', () => {
    expect(scoreConfidence({ similarities: [0.55], embeddingModel: model, meta: null })).toBe(0.8);
  });

  it('clamps retrieval to 0-1 and falls back to a default calibration', () => {
    expect(retrievalScore(0.9, model)).toBe(1);
    expect(retrievalScore(0.1, model)).toBe(0);
    expect(retrievalScore(0.4, 'unknown-model')).toBeCloseTo(0.5);
  });
});

describe('asksForHuman', () => {
  it.each([
    'Can I talk to a real person?',
    'speak to an agent please',
    'human',
    'Connect me with someone from support',
  ])('detects "%s"', (text) => expect(asksForHuman(text)).toBe(true));
  it.each(['How do humans ride e-bikes?', 'What does the agent warranty cover?', 'Hi'])(
    'ignores "%s"',
    (text) => expect(asksForHuman(text)).toBe(false),
  );
});
