import { describe, expect, it } from 'vitest';
import { groupBySimilarity, groupQuestions, groupThresholdFor, normalizeQuestion } from './cluster';
import { LocalHashEmbeddings } from './embeddings';

describe('normalizeQuestion', () => {
  it('lower-cases, collapses spaces and drops trailing punctuation', () => {
    expect(normalizeQuestion('  How LONG is the   warranty?! ')).toBe('how long is the warranty');
    expect(normalizeQuestion('???')).toBe('');
  });
});

describe('groupBySimilarity', () => {
  const v = (...xs: number[]) => {
    const norm = Math.hypot(...xs);
    return xs.map((x) => x / norm);
  };

  it('puts similar vectors together and labels the group with its most-asked text', () => {
    const groups = groupBySimilarity(
      [
        { text: 'a1', weight: 1, vector: v(1, 0.1, 0), item: 1 },
        { text: 'a2', weight: 5, vector: v(1, 0, 0), item: 2 },
        { text: 'b1', weight: 2, vector: v(0, 0, 1), item: 3 },
      ],
      0.9,
    );
    expect(groups.map((g) => [g.label, g.weight, g.members.length])).toEqual([
      ['a2', 6, 2],
      ['b1', 2, 1],
    ]);
  });

  it('keeps unrelated vectors apart and is deterministic', () => {
    const inputs = [
      { text: 'x', weight: 1, vector: v(1, 0), item: 'x' },
      { text: 'y', weight: 1, vector: v(0, 1), item: 'y' },
    ];
    const once = groupBySimilarity(inputs, 0.5);
    expect(once).toHaveLength(2);
    expect(groupBySimilarity([...inputs].reverse(), 0.5)).toEqual(once);
  });
});

describe('groupQuestions (offline embeddings)', () => {
  it('merges identical texts and groups rewordings of the same question', async () => {
    const asked = [
      'Do you sell skateboards?',
      'do you sell skateboards',
      'Do you have skateboards?',
      'How long does delivery take?',
      'How long does shipping take?',
      'Can I return my bike?',
      'How do I return a bike?',
      'What is your return policy?',
    ].map((text, i) => ({ text, id: i }));
    const groups = await groupQuestions(asked, new LocalHashEmbeddings());
    const summary = groups.map((g) => [g.label, g.weight]);
    expect(summary).toContainEqual(['Do you sell skateboards?', 3]);
    expect(summary).toContainEqual(['Can I return my bike?', 3]);
    const delivery = groups.find(
      (g) => g.label.includes('delivery') || g.label.includes('shipping'),
    );
    expect(delivery?.weight).toBe(2);
    // Every original item is kept exactly once.
    expect(groups.flatMap((g) => g.members.flatMap((m) => m.item.map((q) => q.id))).sort()).toEqual(
      asked.map((q) => q.id),
    );
  });

  it('uses a per-model threshold with a safe default', () => {
    expect(groupThresholdFor('local-hash-v2')).toBeLessThan(groupThresholdFor('unknown-model'));
  });
});
