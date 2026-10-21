import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  asksForHuman,
  embedQuestions,
  type EmbeddingProvider,
  type Group,
  groupEmbeddedQuestions,
  groupThresholdFor,
  LocalHashEmbeddings,
} from '@supportpilot/ai';
import { type Database, sql, type TenantTx, withTenant } from '@supportpilot/db';
import {
  ANALYTICS,
  type AnalyticsDay,
  type AnalyticsKpis,
  type AnalyticsOverview,
  type AnalyticsRange,
  datesInRange,
  type MessageFeedback,
  type QuestionGroup,
  redactPii,
  type UnansweredGroup,
  type UnansweredReason,
} from '@supportpilot/shared';
import type { Redis } from 'ioredis';
import { EMBEDDING_PROVIDER } from '../chat/chat.service';
import { DRIZZLE } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

interface ConversationDayRow extends Record<string, unknown> {
  day: string | null;
  conversations: number;
  ai_resolved: number;
  handed_off: number;
  avg_first_response_ms: string | number | null;
  avg_agent_response_ms: string | number | null;
}

interface FeedbackDayRow extends Record<string, unknown> {
  day: string | null;
  ai_answers: number;
  thumbs_up: number;
  thumbs_down: number;
}

interface QuestionRow extends Record<string, unknown> {
  id: string;
  conversation_id: string;
  content: string;
  created_at: Date | string;
  answer_sender: string | null;
  confidence: number | null;
  needs_human: boolean | null;
  feedback: MessageFeedback | null;
  reason: string | null;
}

interface Question {
  /** PII-masked text (what the report shows and what gets embedded). */
  text: string;
  conversationId: string;
  askedAt: string;
  confidence: number | null;
  /** Why the AI failed on it, or null when it answered (or a person did). */
  failure: UnansweredReason | null;
}

const num = (value: string | number | null | undefined) =>
  value === null || value === undefined ? null : Math.round(Number(value));
const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** The AI's own failure first (it knew it was unsure), then the customer's thumbs down. */
function failureOf(row: QuestionRow): UnansweredReason | null {
  if (row.answer_sender !== 'ai') return null;
  // At the plan limit the AI did not try; the chat went to the team (T13).
  if (row.reason === 'plan_limit') return null;
  if (row.needs_human) {
    return row.reason === 'no_relevant_passages' || row.reason === 'llm_error'
      ? 'no_answer'
      : 'low_confidence';
  }
  return row.feedback === 'down' ? 'thumbs_down' : null;
}

/**
 * Analytics for the dashboard. Every query filters by the caller's tenant id (from the verified
 * token) on both conversations and messages, and leaves out dashboard playground chats. Results
 * are cached per tenant and range in Redis for 5 minutes.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  static cacheKey(tenantId: string, range: AnalyticsRange): string {
    return `analytics:v1:${tenantId}:${range.from}:${range.to}:${range.tz}`;
  }

  async overview(
    tenantId: string,
    range: AnalyticsRange,
    options: { fresh?: boolean } = {},
  ): Promise<AnalyticsOverview> {
    const key = AnalyticsService.cacheKey(tenantId, range);
    if (!options.fresh) {
      const hit = await this.redis.get(key).catch(() => null);
      if (hit) return { ...(JSON.parse(hit) as AnalyticsOverview), cached: true };
    }
    const overview = await this.compute(tenantId, range);
    await this.redis
      .set(key, JSON.stringify(overview), 'EX', ANALYTICS.cacheSeconds)
      .catch((error: unknown) =>
        this.logger.warn(`Analytics cache write failed: ${String(error)}`),
      );
    return overview;
  }

  private async compute(tenantId: string, range: AnalyticsRange): Promise<AnalyticsOverview> {
    // Range boundaries are local midnights in the viewer's time zone; `to` is inclusive.
    const start = sql`(${range.from}::date)::timestamp at time zone ${range.tz}`;
    const end = sql`(${range.to}::date + 1)::timestamp at time zone ${range.tz}`;
    // One transaction under row-level security (T15): even a query that lost its tenant filter
    // could only read this tenant's rows.
    const [conversationRows, feedbackRows, questionRows] = await withTenant(
      this.db,
      tenantId,
      async (tx) =>
        [
          await this.conversationDays(tx, tenantId, range.tz, start, end),
          await this.feedbackDays(tx, tenantId, range.tz, start, end),
          await this.questions(tx, tenantId, start, end),
        ] as const,
    );

    const totals = conversationRows.find((r) => r.day === null);
    const ratings = feedbackRows.find((r) => r.day === null);
    const conversations = totals?.conversations ?? 0;
    const thumbsUp = ratings?.thumbs_up ?? 0;
    const thumbsDown = ratings?.thumbs_down ?? 0;
    const kpis: AnalyticsKpis = {
      conversations,
      aiResolved: totals?.ai_resolved ?? 0,
      handedOff: totals?.handed_off ?? 0,
      aiResolvedRate: rate(totals?.ai_resolved ?? 0, conversations),
      handoffRate: rate(totals?.handed_off ?? 0, conversations),
      avgFirstResponseMs: num(totals?.avg_first_response_ms),
      avgAgentResponseMs: num(totals?.avg_agent_response_ms),
      aiAnswers: ratings?.ai_answers ?? 0,
      thumbsUp,
      thumbsDown,
      satisfactionRate: rate(thumbsUp, thumbsUp + thumbsDown),
    };

    const byDay = new Map(conversationRows.map((r) => [r.day, r]));
    const feedbackByDay = new Map(feedbackRows.map((r) => [r.day, r]));
    const daily: AnalyticsDay[] = datesInRange(range.from, range.to).map((date) => ({
      date,
      conversations: byDay.get(date)?.conversations ?? 0,
      aiResolved: byDay.get(date)?.ai_resolved ?? 0,
      handedOff: byDay.get(date)?.handed_off ?? 0,
      thumbsUp: feedbackByDay.get(date)?.thumbs_up ?? 0,
      thumbsDown: feedbackByDay.get(date)?.thumbs_down ?? 0,
    }));

    const questions: Question[] = questionRows
      // "Talk to a person" is a request, not a knowledge gap.
      .filter((row) => !asksForHuman(row.content))
      .map((row) => ({
        text: redactPii(row.content).text.replace(/\s+/g, ' ').trim().slice(0, 300),
        conversationId: row.conversation_id,
        askedAt: new Date(row.created_at).toISOString(),
        confidence: row.confidence === null ? null : Number(row.confidence),
        failure: failureOf(row),
      }))
      .filter((q) => q.text.length >= 3);
    const { topQuestions, unanswered, model } = await this.questionReports(questions);

    return {
      range,
      kpis,
      daily,
      topQuestions,
      unanswered,
      questionsAnalysed: questions.length,
      embeddingModel: model,
      generatedAt: new Date().toISOString(),
      cached: false,
    };
  }

  /** Per day (and the total, day = null): conversations, AI-resolved vs handed off, response times. */
  private async conversationDays(
    db: TenantTx,
    tenantId: string,
    tz: string,
    start: ReturnType<typeof sql>,
    end: ReturnType<typeof sql>,
  ): Promise<ConversationDayRow[]> {
    const result = await db.execute<ConversationDayRow>(sql`
      with conv as (
        select (c.created_at at time zone ${tz})::date as day,
          c.first_handoff_at, fq.at as first_question_at, fr.at as first_reply_at,
          fa.at as first_agent_at
        from conversations c
        left join lateral (
          select min(m.created_at) as at from messages m
          where m.conversation_id = c.id and m.tenant_id = ${tenantId} and m.sender = 'customer'
        ) fq on true
        left join lateral (
          select min(m.created_at) as at from messages m
          where m.conversation_id = c.id and m.tenant_id = ${tenantId}
            and m.sender in ('ai', 'agent') and m.created_at >= fq.at
        ) fr on true
        left join lateral (
          select min(m.created_at) as at from messages m
          where m.conversation_id = c.id and m.tenant_id = ${tenantId}
            and m.sender = 'agent' and m.created_at >= c.first_handoff_at
        ) fa on true
        where c.tenant_id = ${tenantId} and c.visitor_id not like 'playground:%'
          and c.created_at >= ${start} and c.created_at < ${end}
      )
      select day::text as day, count(*)::int as conversations,
        count(*) filter (where first_handoff_at is null)::int as ai_resolved,
        count(*) filter (where first_handoff_at is not null)::int as handed_off,
        avg(extract(epoch from first_reply_at - first_question_at) * 1000) as avg_first_response_ms,
        avg(extract(epoch from first_agent_at - first_handoff_at) * 1000) as avg_agent_response_ms
      from conv
      group by rollup (day)`);
    return result.rows;
  }

  /** Per day (and the total): AI answers and the customers' thumbs up / down on them. */
  private async feedbackDays(
    db: TenantTx,
    tenantId: string,
    tz: string,
    start: ReturnType<typeof sql>,
    end: ReturnType<typeof sql>,
  ): Promise<FeedbackDayRow[]> {
    const result = await db.execute<FeedbackDayRow>(sql`
      with answers as (
        select (m.created_at at time zone ${tz})::date as day, m.feedback
        from messages m
        join conversations c on c.id = m.conversation_id and c.tenant_id = ${tenantId}
        where m.tenant_id = ${tenantId} and m.sender = 'ai'
          and c.visitor_id not like 'playground:%'
          and m.created_at >= ${start} and m.created_at < ${end}
      )
      select day::text as day, count(*)::int as ai_answers,
        count(*) filter (where feedback = 'up')::int as thumbs_up,
        count(*) filter (where feedback = 'down')::int as thumbs_down
      from answers
      group by rollup (day)`);
    return result.rows;
  }

  /** Customer questions (newest first) with the reply that came next, if the AI gave it. */
  private async questions(
    db: TenantTx,
    tenantId: string,
    start: ReturnType<typeof sql>,
    end: ReturnType<typeof sql>,
  ): Promise<QuestionRow[]> {
    const result = await db.execute<QuestionRow>(sql`
      select q.id, q.conversation_id, q.content, q.created_at,
        a.sender as answer_sender, a.confidence, a.needs_human, a.feedback,
        a.metadata->>'reason' as reason
      from messages q
      join conversations c on c.id = q.conversation_id and c.tenant_id = ${tenantId}
      left join lateral (
        select a.sender, a.confidence, a.needs_human, a.feedback, a.metadata from messages a
        where a.conversation_id = q.conversation_id and a.tenant_id = ${tenantId}
          and a.sender <> 'system' and a.created_at > q.created_at
        order by a.created_at, a.id
        limit 1
      ) a on true
      where q.tenant_id = ${tenantId} and q.sender = 'customer'
        and c.visitor_id not like 'playground:%'
        and q.created_at >= ${start} and q.created_at < ${end}
      order by q.created_at desc
      limit ${ANALYTICS.maxQuestions}`);
    return result.rows;
  }

  /**
   * Top questions and the unanswered-questions report: each distinct text is embedded once and
   * grouped by meaning. If the embedding provider fails (e.g. the OpenAI key ran out), the
   * offline model groups by shared words instead, so the report still loads.
   */
  private async questionReports(questions: Question[]): Promise<{
    topQuestions: QuestionGroup[];
    unanswered: UnansweredGroup[];
    model: string;
  }> {
    let provider: EmbeddingProvider = this.embeddings;
    let vectors: Map<string, number[]>;
    try {
      vectors = await embedQuestions(
        questions.map((q) => q.text),
        provider,
      );
    } catch (error) {
      this.logger.warn(`Question grouping fell back to offline embeddings: ${String(error)}`);
      provider = new LocalHashEmbeddings();
      vectors = await embedQuestions(
        questions.map((q) => q.text),
        provider,
      );
    }
    const threshold = groupThresholdFor(provider.model);

    const flatten = (group: Group<Question[]>) => group.members.flatMap((m) => m.item);
    const examples = (group: Group<Question[]>) =>
      group.members
        .slice(1)
        .map((m) => m.text)
        .slice(0, ANALYTICS.examplesPerGroup);
    const lastAsked = (items: Question[]) =>
      items.reduce((latest, q) => (q.askedAt > latest ? q.askedAt : latest), '');

    const topQuestions = groupEmbeddedQuestions(questions, vectors, threshold)
      .slice(0, ANALYTICS.topQuestions)
      .map((group) => {
        const items = flatten(group);
        return {
          question: group.label,
          count: group.weight,
          examples: examples(group),
          lastAskedAt: lastAsked(items),
          unanswered: items.filter((q) => q.failure).length,
        };
      });

    const failed = questions.filter((q) => q.failure);
    const unanswered = groupEmbeddedQuestions(failed, vectors, threshold)
      .slice(0, ANALYTICS.unansweredGroups)
      .map((group) => {
        const items = flatten(group);
        const reasons: Record<UnansweredReason, number> = {
          low_confidence: 0,
          no_answer: 0,
          thumbs_down: 0,
        };
        for (const q of items) reasons[q.failure!] += 1;
        const scored = items.filter((q) => q.confidence !== null);
        const newest = [...items].sort((a, b) => b.askedAt.localeCompare(a.askedAt));
        return {
          question: group.label,
          count: group.weight,
          examples: examples(group),
          lastAskedAt: newest[0]?.askedAt ?? '',
          reasons,
          avgConfidence: scored.length
            ? Math.round((scored.reduce((s, q) => s + q.confidence!, 0) / scored.length) * 1000) /
              1000
            : null,
          conversationIds: [...new Set(newest.map((q) => q.conversationId))].slice(0, 3),
        };
      });

    return { topQuestions, unanswered, model: provider.model };
  }
}
