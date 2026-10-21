import { describe, expect, it } from 'vitest';
import {
  type AnalyticsOverview,
  analyticsCsv,
  analyticsQuerySchema,
  csvCell,
  datesInRange,
  dateInZone,
  isValidTimeZone,
  resolveAnalyticsRange,
  toCsv,
} from './analytics';

describe('analyticsQuerySchema', () => {
  it('accepts dates, a time zone and the fresh flag', () => {
    expect(
      analyticsQuerySchema.parse({
        from: '2026-10-01',
        to: '2026-10-21',
        tz: 'Asia/Kolkata',
        fresh: '1',
      }),
    ).toEqual({ from: '2026-10-01', to: '2026-10-21', tz: 'Asia/Kolkata', fresh: '1' });
    expect(analyticsQuerySchema.parse({})).toEqual({});
  });

  it.each([
    [{ from: '2026-13-01' }],
    [{ from: '21/10/2026' }],
    [{ tz: 'Mars/Olympus' }],
    [{ tz: "UTC'; drop table x" }],
    [{ from: '2026-10-21', to: '2026-10-01' }],
  ])('rejects %j', (query) => {
    expect(analyticsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('ranges', () => {
  const now = new Date('2026-10-21T20:30:00Z');

  it('defaults to the last 30 days ending today in the time zone', () => {
    expect(resolveAnalyticsRange({}, now)).toEqual({
      from: '2026-09-22',
      to: '2026-10-21',
      tz: 'UTC',
    });
    // 20:30 UTC is already the 22nd in India.
    expect(resolveAnalyticsRange({ tz: 'Asia/Kolkata' }, now)).toMatchObject({ to: '2026-10-22' });
  });

  it('fills a missing end from the start and limits the length', () => {
    expect(resolveAnalyticsRange({ from: '2026-01-01' }, now)).toMatchObject({ to: '2026-01-30' });
    expect(resolveAnalyticsRange({ from: '2024-01-01', to: '2026-01-01' }, now)).toMatch(/at most/);
  });

  it('lists every day of a range, across month ends', () => {
    expect(datesInRange('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('formats dates in a zone and validates zone names', () => {
    expect(dateInZone(now, 'America/Los_Angeles')).toBe('2026-10-21');
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Nope/Nowhere')).toBe(false);
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and new lines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('neutralises spreadsheet formulas in text cells (CSV injection)', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-3)).toBe('-3'); // numbers stay numbers
  });

  it('builds CRLF-separated rows with a header', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });

  it('exports each report of an overview', () => {
    const overview = {
      daily: [
        {
          date: '2026-10-20',
          conversations: 3,
          aiResolved: 2,
          handedOff: 1,
          thumbsUp: 1,
          thumbsDown: 0,
        },
      ],
      topQuestions: [
        {
          question: 'Warranty?',
          count: 4,
          unanswered: 1,
          lastAskedAt: '2026-10-20T10:00:00.000Z',
          examples: ['a', 'b'],
        },
      ],
      unanswered: [
        {
          question: 'Skateboards?',
          count: 2,
          reasons: { low_confidence: 0, no_answer: 2, thumbs_down: 0 },
          avgConfidence: 0.123,
          lastAskedAt: '2026-10-20T10:00:00.000Z',
          examples: [],
          conversationIds: [],
        },
      ],
    } as unknown as AnalyticsOverview;
    expect(analyticsCsv(overview, 'daily')).toContain('2026-10-20,3,2,1,1,0');
    expect(analyticsCsv(overview, 'questions')).toContain(
      'Warranty?,4,1,2026-10-20T10:00:00.000Z,a | b',
    );
    expect(analyticsCsv(overview, 'unanswered')).toContain('Skateboards?,2,0,2,0,12.3,');
  });
});
