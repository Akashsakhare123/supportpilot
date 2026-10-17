/** Kinds of personal data masked before text is sent to an AI provider. */
export type PiiKind = 'email' | 'phone' | 'card';

export interface RedactionResult {
  text: string;
  found: PiiKind[];
}

/** Luhn checksum: tells real card numbers apart from order numbers of the same length. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13-19 digits, optionally separated by spaces or dashes.
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
// International or local phone numbers: 9-15 digits with common separators.
const PHONE = /(?<![\w])\+?\d[\d ().-]{7,18}\d(?![\w])/g;

/**
 * Mask emails, card numbers (Luhn-checked) and phone numbers. Basic by design (T07); T15 adds
 * redaction in logs and an eval for it.
 */
export function redactPii(input: string): RedactionResult {
  const found = new Set<PiiKind>();
  let text = input.replace(EMAIL, () => {
    found.add('email');
    return '[email]';
  });
  text = text.replace(CARD, (match) => {
    const digits = match.replace(/\D/g, '');
    if (!luhnValid(digits)) return match;
    found.add('card');
    return '[card number]';
  });
  text = text.replace(PHONE, (match) => {
    const digits = match.replace(/\D/g, '').length;
    if (digits < 9 || digits > 15) return match;
    // A long bare run of digits is more likely an order or tracking number than a phone.
    if (/^\d+$/.test(match) && digits > 11) return match;
    found.add('phone');
    return '[phone]';
  });
  return { text, found: [...found] };
}
