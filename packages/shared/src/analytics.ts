import { z } from 'zod';

export const ANALYTICS = {
  defaultRangeDays: 30,
  maxRangeDays: 366,
  /** Results are cached per tenant + range in Redis for 5 minutes. */
  cacheSeconds: 300,
  /** Most recent customer questions analysed per report (grouping cost stays bounded). */
  maxQuestions: 2000,
  topQuestions: 10,
  unansweredGroups: 25,
  examplesPerGroup: 3,
} as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real IANA time zone name ("Europe/Berlin"); invalid names make Intl throw. */
export function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const dateString = z
  .string()
  .regex(DATE, 'Use YYYY-MM-DD dates')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a valid date');

/** Query string of GET /analytics and /analytics/export (dates are inclusive, in `tz`). */
export const analyticsQuerySchema = z
  .object({
    from: dateString.optional(),
    to: dateString.optional(),
    tz: z.string().refine(isValidTimeZone, 'Unknown time zone').optional(),
    /** Skip the 5-minute cache (the Refresh button). */
    fresh: z.enum(['1', 'true']).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '"from" must be before "to"' });
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface AnalyticsRange {
  from: string;
  to: string;
  tz: string;
}

/** YYYY-MM-DD of `date` in a time zone. */
export function dateInZone(date: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Fill in the defaults (the last 30 days up to today in `tz`, UTC if none) and enforce the
 * maximum range. Returns an error message for a range that is too long.
 */
export function resolveAnalyticsRange(
  query: Pick<AnalyticsQuery, 'from' | 'to' | 'tz'>,
  now = new Date(),
): AnalyticsRange | string {
  const tz = query.tz ?? 'UTC';
  const to =
    query.to ??
    (query.from ? addDays(query.from, ANALYTICS.defaultRangeDays - 1) : dateInZone(now, tz));
  const from = query.from ?? addDays(to, -(ANALYTICS.defaultRangeDays - 1));
  if (from > to) return '"from" must be before "to"';
  if (daysBetween(from, to) + 1 > ANALYTICS.maxRangeDays) {
    return `Choose a range of at most ${ANALYTICS.maxRangeDays} days`;
  }
  return { from, to, tz };
}

/** Every date from `from` to `to` (inclusive), so charts show days without conversations. */
export function datesInRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

export interface AnalyticsKpis {
  conversations: number;
  /** Conversations no person had to touch. */
  aiResolved: number;
  /** Conversations that went to a person at some point (waiting or claimed). */
  handedOff: number;
  /** 0-1, null when there were no conversations. */
  aiResolvedRate: number | null;
  handoffRate: number | null;
  /** Customer's first message -> first reply (AI or agent), average in ms. */
  avgFirstResponseMs: number | null;
  /** Hand-off -> first agent reply, average in ms (handed-off chats an agent answered). */
  avgAgentResponseMs: number | null;
  aiAnswers: number;
  thumbsUp: number;
  thumbsDown: number;
  /** Thumbs up / all ratings, null without ratings. */
  satisfactionRate: number | null;
}

export interface AnalyticsDay {
  date: string;
  conversations: number;
  aiResolved: number;
  handedOff: number;
  thumbsUp: number;
  thumbsDown: number;
}

export interface QuestionGroup {
  /** The most-asked wording in the group (PII masked). */
  question: string;
  count: number;
  /** Other wordings customers used (up to 3). */
  examples: string[];
  lastAskedAt: string;
  /** How many of these the AI could not answer confidently (or got a thumbs down). */
  unanswered: number;
}

export const unansweredReasons = ['low_confidence', 'no_answer', 'thumbs_down'] as const;
export type UnansweredReason = (typeof unansweredReasons)[number];

export const UNANSWERED_REASON_LABELS: Record<UnansweredReason, string> = {
  low_confidence: 'Low confidence',
  no_answer: 'No answer found',
  thumbs_down: 'Thumbs down',
};

export interface UnansweredGroup extends Omit<QuestionGroup, 'unanswered'> {
  reasons: Record<UnansweredReason, number>;
  /** Average confidence of the AI's answers to these questions. */
  avgConfidence: number | null;
  /** Conversations where the question was asked (newest first, up to 3). */
  conversationIds: string[];
}

export interface AnalyticsOverview {
  range: AnalyticsRange;
  kpis: AnalyticsKpis;
  daily: AnalyticsDay[];
  topQuestions: QuestionGroup[];
  unanswered: UnansweredGroup[];
  /** Customer questions analysed for the two question reports. */
  questionsAnalysed: number;
  embeddingModel: string;
  generatedAt: string;
  /** Served from the 5-minute cache. */
  cached: boolean;
}

export const analyticsExports = ['daily', 'questions', 'unanswered'] as const;
export type AnalyticsExport = (typeof analyticsExports)[number];

type Cell = string | number | boolean | null | undefined;

/**
 * One CSV cell (RFC 4180 quoting). Cells that a spreadsheet would run as a formula (= + - @, tab,
 * carriage return) get a leading apostrophe: customer questions are untrusted text.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const pct = (rate: number | null) => (rate === null ? '' : Math.round(rate * 1000) / 10);

/** The CSV for one export of an overview. */
export function analyticsCsv(overview: AnalyticsOverview, report: AnalyticsExport): string {
  switch (report) {
    case 'daily':
      return toCsv(
        ['date', 'conversations', 'ai_resolved', 'handed_off', 'thumbs_up', 'thumbs_down'],
        overview.daily.map((d) => [
          d.date,
          d.conversations,
          d.aiResolved,
          d.handedOff,
          d.thumbsUp,
          d.thumbsDown,
        ]),
      );
    case 'questions':
      return toCsv(
        ['question', 'times_asked', 'unanswered', 'last_asked_at', 'other_wordings'],
        overview.topQuestions.map((q) => [
          q.question,
          q.count,
          q.unanswered,
          q.lastAskedAt,
          q.examples.join(' | '),
        ]),
      );
    case 'unanswered':
      return toCsv(
        [
          'question',
          'times_asked',
          'low_confidence',
          'no_answer',
          'thumbs_down',
          'avg_confidence_pct',
          'last_asked_at',
          'other_wordings',
        ],
        overview.unanswered.map((q) => [
          q.question,
          q.count,
          q.reasons.low_confidence,
          q.reasons.no_answer,
          q.reasons.thumbs_down,
          pct(q.avgConfidence),
          q.lastAskedAt,
          q.examples.join(' | '),
        ]),
      );
  }
}
