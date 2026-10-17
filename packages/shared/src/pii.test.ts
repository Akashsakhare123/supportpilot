import { describe, expect, it } from 'vitest';
import { luhnValid, redactPii } from './pii';

describe('redactPii', () => {
  it('masks emails, phone numbers and real card numbers', () => {
    const { text, found } = redactPii(
      'Mail jane.doe+bikes@example.co.uk or call +1 (415) 555-0134, card 4242 4242 4242 4242.',
    );
    expect(text).toBe('Mail [email] or call [phone], card [card number].');
    expect(found.sort()).toEqual(['card', 'email', 'phone']);
  });

  it('keeps order numbers, sizes, prices and dates', () => {
    const input = 'Order 1234567890123 for a 54 cm frame, $1,299.00, delivered 2026-10-17.';
    expect(redactPii(input)).toEqual({ text: input, found: [] });
  });

  it('leaves ordinary questions untouched', () => {
    expect(redactPii('How long is the frame warranty?').found).toEqual([]);
  });
});

describe('luhnValid', () => {
  it('accepts test card numbers and rejects typos', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(luhnValid('')).toBe(false);
  });
});
