import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AnswerStreamSplitter,
  asksForHuman,
  buildRagMessages,
  calibrationFor,
  citedRefs,
  type AnswerMeta,
  type EmbeddingProvider,
  type LlmProvider,
  scoreConfidence,
} from '@supportpilot/ai';
import {
  and,
  asc,
  conversations,
  type ConversationRow,
  type Database,
  desc,
  eq,
  messages,
  type MessageRow,
  searchChunks,
  sql,
  type Tenant,
  usageEvents,
} from '@supportpilot/db';
import {
  CHAT_LIMITS,
  type ChatDone,
  type ChatSource,
  LOW_CONFIDENCE_LIMIT,
  redactPii,
  WIDGET_LIMITS,
  type WidgetHistory,
  type WidgetHistoryRequest,
} from '@supportpilot/shared';
import { loadMessagePage } from '../common/message-page';
import { DRIZZLE } from '../database/database.module';
import { HANDOFF_TEXT, HandoffService } from '../handoff/handoff.service';
import { InboxService } from '../inbox/inbox.service';

/** Dashboard playground conversations never go to the inbox or change status. */
const isPlayground = (c: ConversationRow) => c.visitorId.startsWith('playground:');

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export const CHAT_TEXT = {
  notFound:
    "I'm sorry, I couldn't find that in our help articles. Would you like me to connect you with a person from our team?",
  error:
    "Sorry, I'm having trouble answering right now. Would you like me to connect you with a person from our team?",
} as const;

export interface ChatTurnInput {
  tenant: Tenant;
  visitorId: string;
  conversationId?: string;
  message: string;
  origin?: string;
}

/** Receives the stream as it is produced (SSE today, the socket gateway in T08 / T09). */
export interface ChatSink {
  meta(conversationId: string): void;
  delta(text: string): void;
}

/**
 * The RAG pipeline, shared by POST /v1/chat (widget), the dashboard playground and, later, the
 * socket gateway: PII masking -> embed question -> tenant-scoped top-k -> grounded prompt ->
 * streamed answer -> sources + confidence -> persisted messages + usage event.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly inbox: InboxService,
    private readonly handoff: HandoffService,
  ) {}

  /**
   * Find the visitor's conversation (or start one). Runs before the stream opens, so an unknown
   * conversation is a normal 404. Another tenant's or visitor's conversation is "not found".
   */
  async openConversation(input: ChatTurnInput): Promise<ConversationRow> {
    if (input.conversationId) {
      const existing = await this.db.query.conversations.findFirst({
        where: and(
          eq(conversations.id, input.conversationId),
          eq(conversations.tenantId, input.tenant.id),
          eq(conversations.visitorId, input.visitorId),
        ),
      });
      if (!existing) throw new NotFoundException('Conversation not found');
      if (existing.status !== 'closed') return existing;
    }
    const [created] = await this.db
      .insert(conversations)
      .values({ tenantId: input.tenant.id, visitorId: input.visitorId, origin: input.origin })
      .returning();
    return created!;
  }

  /** Answer one customer message in a conversation opened with openConversation(). */
  async respond(
    tenant: Tenant,
    conversation: ConversationRow,
    message: string,
    sink: ChatSink,
    signal?: AbortSignal,
  ): Promise<ChatDone> {
    const started = Date.now();
    sink.meta(conversation.id);
    const pii = redactPii(message);
    const history = await this.recentHistory(conversation.id);
    const [customerMessage] = await this.db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        tenantId: tenant.id,
        sender: 'customer',
        content: message,
        metadata: pii.found.length ? { piiMasked: pii.found } : {},
      })
      .returning();
    await this.touch(conversation.id, {});
    await this.notifyInbox(tenant.id, customerMessage!);

    // A person is handling (or about to handle) this chat: the AI stays out of it.
    if (conversation.status === 'human' || conversation.status === 'waiting') {
      return {
        conversationId: conversation.id,
        messageId: null,
        content: '',
        sources: [],
        confidence: 0,
        needsHuman: conversation.status === 'waiting',
        conversationStatus: conversation.status,
      };
    }

    if (asksForHuman(message)) {
      // Real conversations go to "waiting" (playground tests only show the reply).
      const handoff = isPlayground(conversation)
        ? null
        : await this.handoff.requestHuman(tenant.id, conversation, 'customer_request');
      const text =
        handoff && !handoff.agentsOnline ? HANDOFF_TEXT.offline : HANDOFF_TEXT.connecting;
      sink.delta(text);
      const done = await this.finish(tenant, conversation, started, {
        content: text,
        sources: [],
        confidence: 0,
        needsHuman: true,
        metadata: { reason: 'customer_asked_for_human' },
        resetStreak: true,
      });
      return { ...done, conversationStatus: handoff?.status ?? done.conversationStatus };
    }

    // Retrieval: the masked question, this tenant only, same embedding model only.
    const [queryVector] = await this.embeddings.embed([pii.text]);
    const { floor } = calibrationFor(this.embeddings.model);
    const hits = (
      await searchChunks(this.db, {
        tenantId: tenant.id,
        embedding: queryVector!,
        embeddingModel: this.embeddings.model,
        limit: CHAT_LIMITS.topK,
      })
    ).filter((hit) => hit.similarity >= floor);
    const retrieval = {
      embeddingModel: this.embeddings.model,
      topSimilarity: hits[0]?.similarity ?? null,
      passages: hits.length,
    };

    if (hits.length === 0) {
      sink.delta(CHAT_TEXT.notFound);
      return this.afterAnswer(
        tenant,
        conversation,
        await this.finish(tenant, conversation, started, {
          content: CHAT_TEXT.notFound,
          sources: [],
          confidence: 0,
          needsHuman: true,
          metadata: { reason: 'no_relevant_passages', retrieval },
        }),
      );
    }

    const prompt = buildRagMessages({
      tenantName: tenant.name,
      question: pii.text,
      passages: hits.map((hit, i) => ({
        ref: i + 1,
        title: hit.documentTitle,
        headingPath: hit.headingPath,
        content: hit.content,
      })),
      history: history.map((m) => ({
        role: m.sender === 'customer' ? ('customer' as const) : ('assistant' as const),
        content: m.sender === 'customer' ? redactPii(m.content).text : m.content,
      })),
    });

    // Generation, streamed; the metadata line is split off and never shown.
    const splitter = new AnswerStreamSplitter();
    let content = '';
    let firstTokenMs: number | null = null;
    let meta: AnswerMeta | null = null;
    let failure: string | null = null;
    try {
      for await (const chunk of this.llm.stream(prompt, { signal })) {
        if (signal?.aborted) break;
        const visible = splitter.push(chunk);
        if (visible) {
          firstTokenMs ??= Date.now() - started;
          content += visible;
          sink.delta(visible);
        }
      }
      const end = splitter.finish();
      if (end.rest) {
        content += end.rest;
        sink.delta(end.rest);
      }
      meta = end.meta;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (!signal?.aborted) this.logger.warn(`LLM failed for tenant ${tenant.id}: ${failure}`);
    }
    content = content.trim();

    if (failure && !signal?.aborted && !content) {
      sink.delta(CHAT_TEXT.error);
      return this.afterAnswer(
        tenant,
        conversation,
        await this.finish(tenant, conversation, started, {
          content: CHAT_TEXT.error,
          sources: [],
          confidence: 0,
          needsHuman: true,
          metadata: { reason: 'llm_error', error: failure.slice(0, 300), retrieval },
        }),
      );
    }

    // Sources = passages the answer cites (inline [n] or in the metadata), if they exist.
    const refs = [...new Set([...citedRefs(content), ...(meta?.sources ?? [])])].filter(
      (ref) => ref >= 1 && ref <= hits.length,
    );
    const answered = meta?.answered !== false;
    const sources: ChatSource[] = answered
      ? refs.map((ref) => {
          const hit = hits[ref - 1]!;
          return {
            ref,
            chunkId: hit.chunkId,
            documentId: hit.documentId,
            documentTitle: hit.documentTitle,
            documentUrl: hit.documentUrl,
            headingPath: hit.headingPath,
            snippet: hit.content.slice(0, 200),
            similarity: Math.round(hit.similarity * 1000) / 1000,
          };
        })
      : [];
    const confidence = scoreConfidence({
      similarities: sources.length
        ? sources.map((s) => s.similarity)
        : hits.map((h) => h.similarity),
      embeddingModel: this.embeddings.model,
      meta,
    });
    const needsHuman = confidence < tenant.handoffThreshold;
    const done = await this.finish(tenant, conversation, started, {
      content: content || CHAT_TEXT.notFound,
      sources,
      confidence,
      needsHuman,
      metadata: {
        model: this.llm.model,
        firstTokenMs,
        retrieval,
        selfConfidence: meta?.confidence ?? null,
        answered,
        ...(signal?.aborted ? { aborted: true } : {}),
        ...(pii.found.length ? { piiMasked: pii.found } : {}),
      },
    });
    return this.afterAnswer(tenant, conversation, done);
  }

  /** Low confidence twice in a row: hand the conversation to a person (ai -> waiting). */
  private async afterAnswer(
    tenant: Tenant,
    conversation: ConversationRow,
    done: ChatDone,
  ): Promise<ChatDone> {
    const streak = done.needsHuman ? conversation.lowConfidenceStreak + 1 : 0;
    if (streak < LOW_CONFIDENCE_LIMIT || isPlayground(conversation)) return done;
    const handoff = await this.handoff.requestHuman(tenant.id, conversation, 'low_confidence');
    return { ...done, conversationStatus: handoff.status };
  }

  /** Previous messages (oldest first), the conversation memory given to the model. */
  private async recentHistory(conversationId: string) {
    const rows = await this.db
      .select({ sender: messages.sender, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(CHAT_LIMITS.historyMessages);
    return rows.reverse().filter((m) => m.sender !== 'system' && m.content.trim());
  }

  /** Live inbox update; a failure here must never break the customer's chat. */
  private async notifyInbox(tenantId: string, row: MessageRow): Promise<void> {
    try {
      await this.inbox.messageStored(tenantId, row);
    } catch (error) {
      this.logger.warn(
        `Inbox update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async touch(conversationId: string, set: Partial<ConversationRow>): Promise<void> {
    await this.db
      .update(conversations)
      .set({ ...set, lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  }

  /** Persist the AI answer, update the conversation and meter the answer. */
  private async finish(
    tenant: Tenant,
    conversation: ConversationRow,
    started: number,
    answer: {
      content: string;
      sources: ChatSource[];
      confidence: number;
      needsHuman: boolean;
      metadata: Record<string, unknown>;
      /** A handoff starts now, so the low-confidence streak starts over. */
      resetStreak?: boolean;
    },
  ): Promise<ChatDone> {
    const latencyMs = Date.now() - started;
    const [saved] = await this.db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        tenantId: tenant.id,
        sender: 'ai',
        content: answer.content,
        sources: answer.sources,
        confidence: answer.confidence,
        needsHuman: answer.needsHuman,
        metadata: { ...answer.metadata, latencyMs },
      })
      .returning();
    await this.touch(conversation.id, {
      lowConfidenceStreak:
        answer.needsHuman && !answer.resetStreak ? conversation.lowConfidenceStreak + 1 : 0,
    });
    await this.notifyInbox(tenant.id, saved!);
    await this.db.insert(usageEvents).values({
      tenantId: tenant.id,
      type: 'chat.answer',
      metadata: { conversationId: conversation.id, model: this.llm.model, latencyMs },
    });
    return {
      conversationId: conversation.id,
      messageId: saved!.id,
      content: answer.content,
      sources: answer.sources,
      confidence: answer.confidence,
      needsHuman: answer.needsHuman,
      // Status changes (ai -> waiting) are the HandoffService's job in T10.
      conversationStatus: conversation.status,
    };
  }

  /**
   * A visitor's own conversation for the widget: the latest page after a reload, an older page
   * (before) or the messages missed while disconnected (after); oldest first, system notes hidden.
   * "not_found" when it does not exist or belongs to another tenant or visitor.
   */
  async visitorHistory(
    tenantId: string,
    visitorId: string,
    request: WidgetHistoryRequest,
  ): Promise<WidgetHistory | 'not_found' | 'unknown_cursor'> {
    const conversation = await this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.id, request.conversationId),
        eq(conversations.tenantId, tenantId),
        eq(conversations.visitorId, visitorId),
      ),
      columns: { id: true, status: true, agentReadAt: true, visitorReadAt: true },
    });
    if (!conversation) return 'not_found';
    const page = await loadMessagePage(this.db, {
      tenantId,
      conversationId: conversation.id,
      before: request.before,
      after: request.after,
      limit: request.limit ?? WIDGET_LIMITS.historyMessages,
      hideSystem: true,
    });
    if (!page) return 'unknown_cursor';
    const [unread] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.sender, 'agent'),
          conversation.visitorReadAt
            ? sql`${messages.createdAt} > ${conversation.visitorReadAt}`
            : undefined,
        ),
      );
    return {
      messages: page.rows.map(({ message: m }) => ({
        id: m.id,
        sender: m.sender,
        content: m.content,
        sources: m.sources,
        createdAt: m.createdAt.toISOString(),
      })),
      hasMore: page.hasMore,
      status: conversation.status,
      unread: Number(unread?.count ?? 0),
      agentReadAt: conversation.agentReadAt?.toISOString() ?? null,
    };
  }

  /** Messages of a conversation, oldest first (playground history, tests). */
  async listMessages(tenantId: string, conversationId: string) {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)))
      .orderBy(asc(messages.createdAt));
  }
}
