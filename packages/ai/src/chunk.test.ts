import { describe, expect, it } from 'vitest';
import { chunkEmbeddingText, chunkText, estimateTokens } from './chunk';

describe('chunkText', () => {
  it('keeps markdown sections apart and records the heading trail', () => {
    const chunks = chunkText(
      '# Warranty\nFrames have a lifetime warranty.\n\n## Claims\nEmail support with a photo.\n\n# Shipping\nWe ship in 3-5 days.',
    );
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ['Warranty'],
      ['Warranty', 'Claims'],
      ['Shipping'],
    ]);
    expect(chunks[1]!.content).toBe('Email support with a photo.');
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('splits long sections under the token limit with overlap between chunks', () => {
    const paragraphs = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i} explains one detail of the returns policy in a full sentence.`,
    );
    const chunks = chunkText(`# Returns\n${paragraphs.join('\n\n')}`, {
      maxTokens: 100,
      overlapTokens: 25,
    });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(110);
    // The last paragraph of a chunk is repeated at the start of the next one.
    const lastOfFirst = chunks[0]!.content.split('\n\n').at(-1)!;
    expect(chunks[1]!.content.startsWith(lastOfFirst)).toBe(true);
    // Nothing is lost.
    const all = chunks.map((c) => c.content).join('\n\n');
    for (const p of paragraphs) expect(all).toContain(p);
  });

  it('breaks a single huge paragraph at sentence boundaries', () => {
    const sentence = 'This sentence is about tyre pressure and nothing else. ';
    const chunks = chunkText(sentence.repeat(200), { maxTokens: 50, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200);
      expect(chunk.content.endsWith('.')).toBe(true);
    }
  });

  it('handles plain text without headings, CRLF line endings and empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
    const [only] = chunkText('Line one\r\nline two\r\n\r\nSecond paragraph');
    expect(only!.headingPath).toEqual([]);
    expect(only!.content).toBe('Line one\nline two\n\nSecond paragraph');
  });
});

describe('chunkEmbeddingText', () => {
  it('prefixes the title and heading trail', () => {
    expect(
      chunkEmbeddingText('Warranty', { headingPath: ['Frames', 'Claims'], content: 'Email us.' }),
    ).toBe('Warranty\nFrames > Claims\n\nEmail us.');
    expect(chunkEmbeddingText('FAQ', { headingPath: [], content: 'Hi' })).toBe('FAQ\n\nHi');
  });
});

describe('estimateTokens', () => {
  it('is about four characters per token', () => {
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
  });
});
