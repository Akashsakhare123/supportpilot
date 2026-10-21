import { RedactingLogger, redactForLog } from './redacting-logger';

describe('RedactingLogger', () => {
  const pii = 'Customer jane.doe@example.com called from +1 415 555 0134, card 4242 4242 4242 4242';

  it('masks emails, phone numbers and card numbers in strings, errors and objects', () => {
    const text = redactForLog(pii) as string;
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).not.toContain('4242 4242 4242 4242');
    expect(text).not.toContain('555 0134');
    expect((redactForLog(new Error(pii)) as Error).message).not.toContain('@example.com');
    expect(JSON.stringify(redactForLog({ note: pii }))).not.toContain('jane.doe');
    expect(redactForLog(42)).toBe(42);
  });

  it('never writes PII to stdout or stderr', () => {
    const written: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const logger = new RedactingLogger('Test');
      logger.log(pii);
      logger.warn(`Failed for ${pii}`);
      logger.error(pii, `Error: ${pii}\n    at stack`);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const all = written.join('');
    expect(all).toContain('Customer');
    expect(all).not.toMatch(/jane\.doe@example\.com|4242 4242 4242 4242|555 0134/);
  });
});
