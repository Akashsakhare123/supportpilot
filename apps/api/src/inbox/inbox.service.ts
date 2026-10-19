import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  conversations,
  type Database,
  eq,
  messages,
  type MessageRow,
  sql,
  users,
} from '@supportpilot/db';
import type {
  AgentMessage,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  HistoryMessage,
  InboxList,
  InboxTab,
  MessagePage,
  MessagePageQuery,
  MessageSender,
} from '@supportpilot/shared';
import { loadMessagePage } from '../common/message-page';
import { DRIZZLE } from '../database/database.module';
import { RealtimeService } from '../realtime/realtime.service';

/** Conversations from the dashboard playground never show up in the inbox. */
const NOT_PLAYGROUND = sql`c.visitor_id not like 'playground:%'`;

function tabFilter(tab: InboxTab, userId: string) {
  switch (tab) {
    case 'needs_agent':
      return sql`(c.status = 'waiting' or (c.status = 'ai' and c.low_confidence_streak > 0))`;
    case 'mine':
      return sql`(c.status = 'human' and c.assigned_agent_id = ${userId})`;
    case 'team':
      return sql`(c.status = 'human' and c.assigned_agent_id is distinct from ${userId})`;
    case 'ai':
      return sql`(c.status = 'ai' and c.low_confidence_streak = 0)`;
    case 'closed':
      return sql`c.status = 'closed'`;
  }
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  status: ConversationStatus;
  visitor_id: string;
  origin: string | null;
  assigned_agent_id: string | null;
  agent_name: string | null;
  low_confidence_streak: number;
  handoff_reason: string | null;
  contact_email: string | null;
  last_message_at: Date | string;
  created_at: Date | string;
  last_sender: MessageSender | null;
  last_content: string | null;
  last_created_at: Date | string | null;
  last_confidence: number | null;
  message_count: number;
  unread_count: number;
  visitor_read_at: Date | string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

function toSummary(row: SummaryRow): ConversationSummary {
  return {
    id: row.id,
    status: row.status,
    visitorLabel: `Visitor ${row.visitor_id.replace(/^v_/, '').slice(0, 6)}`,
    origin: row.origin,
    assignedAgentId: row.assigned_agent_id,
    assignedAgentName: row.agent_name,
    lastMessage:
      row.last_sender && row.last_content !== null && row.last_created_at
        ? {
            sender: row.last_sender,
            content: row.last_content.slice(0, 160),
            createdAt: iso(row.last_created_at),
          }
        : null,
    lastConfidence: row.last_confidence === null ? null : Number(row.last_confidence),
    lowConfidenceStreak: Number(row.low_confidence_streak),
    handoffReason: row.handoff_reason,
    contactEmail: row.contact_email,
    messageCount: Number(row.message_count),
    unreadCount: Number(row.unread_count),
    visitorReadAt: row.visitor_read_at ? iso(row.visitor_read_at) : null,
    lastMessageAt: iso(row.last_message_at),
    createdAt: iso(row.created_at),
  };
}

/**
 * The agent inbox: lists, conversation detail and storing messages (status changes live in
 * HandoffService). Every query is
 * scoped by the caller's tenant id (taken from the verified token). After each change the
 * RealtimeService pushes the new state to dashboards and the visitor's widget.
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {}

  private async summaries(tenantId: string, where: ReturnType<typeof sql>, limit: number) {
    const result = await this.db.execute<SummaryRow>(sql`
      select c.id, c.status, c.visitor_id, c.origin, c.assigned_agent_id, u.name as agent_name,
        c.low_confidence_streak, c.handoff_reason, c.contact_email, c.last_message_at, c.created_at,
        lm.sender as last_sender, lm.content as last_content, lm.created_at as last_created_at,
        (select m2.confidence from messages m2
          where m2.conversation_id = c.id and m2.sender = 'ai'
          order by m2.created_at desc limit 1) as last_confidence,
        (select count(*)::int from messages m3 where m3.conversation_id = c.id) as message_count,
        -- Unread only matters while a person is needed; AI-handled chats are not a to-do.
        case when c.status in ('waiting', 'human') then
          (select count(*)::int from messages m4
            where m4.conversation_id = c.id and m4.sender = 'customer'
              and m4.created_at > coalesce(c.agent_read_at, '-infinity'::timestamptz))
        else 0 end as unread_count,
        c.visitor_read_at
      from conversations c
      left join users u on u.id = c.assigned_agent_id
      left join lateral (
        select m.sender, m.content, m.created_at from messages m
        where m.conversation_id = c.id and m.sender <> 'system'
        order by m.created_at desc limit 1
      ) lm on true
      where c.tenant_id = ${tenantId} and ${NOT_PLAYGROUND} and ${where}
      order by c.last_message_at desc
      limit ${limit}`);
    return result.rows.map(toSummary);
  }

  async list(tenantId: string, userId: string, tab: InboxTab): Promise<InboxList> {
    const [items, counts] = await Promise.all([
      this.summaries(tenantId, tabFilter(tab, userId), 100),
      this.counts(tenantId, userId),
    ]);
    return { items, counts };
  }

  async counts(tenantId: string, userId: string): Promise<Record<InboxTab, number>> {
    const result = await this.db.execute<Record<InboxTab, number>>(sql`
      select
        count(*) filter (where ${tabFilter('needs_agent', userId)})::int as needs_agent,
        count(*) filter (where ${tabFilter('mine', userId)})::int as mine,
        count(*) filter (where ${tabFilter('team', userId)})::int as team,
        count(*) filter (where ${tabFilter('ai', userId)})::int as ai,
        count(*) filter (where ${tabFilter('closed', userId)})::int as closed
      from conversations c
      where c.tenant_id = ${tenantId} and ${NOT_PLAYGROUND}`);
    const row = result.rows[0];
    return {
      needs_agent: Number(row?.needs_agent ?? 0),
      mine: Number(row?.mine ?? 0),
      team: Number(row?.team ?? 0),
      ai: Number(row?.ai ?? 0),
      closed: Number(row?.closed ?? 0),
    };
  }

  /** Summary of one conversation, or null for unknown / other tenant / playground. */
  async summary(tenantId: string, conversationId: string): Promise<ConversationSummary | null> {
    const [row] = await this.summaries(tenantId, sql`c.id = ${conversationId}`, 1);
    return row ?? null;
  }

  /** The conversation with its latest page of messages (older pages via messagePage). */
  async detail(tenantId: string, conversationId: string): Promise<ConversationDetail> {
    const conversation = await this.summary(tenantId, conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');
    const page = await this.loadPage(tenantId, conversationId, {});
    return { conversation, ...page };
  }

  /**
   * Older messages (before) or the ones missed during a reconnect (after), oldest first. Another
   * tenant's conversation is a 404, not an empty page.
   */
  async messagePage(
    tenantId: string,
    conversationId: string,
    query: MessagePageQuery,
  ): Promise<MessagePage<AgentMessage>> {
    const owned = await this.db.query.conversations.findFirst({
      where: and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)),
      columns: { id: true },
    });
    if (!owned) throw new NotFoundException('Conversation not found');
    return this.loadPage(tenantId, conversationId, query);
  }

  private async loadPage(
    tenantId: string,
    conversationId: string,
    query: MessagePageQuery,
  ): Promise<MessagePage<AgentMessage>> {
    const page = await loadMessagePage(this.db, { tenantId, conversationId, ...query });
    if (!page) throw new NotFoundException('Message not found in this conversation');
    return {
      messages: page.rows.map((r) => this.toAgentMessage(r.message, r.authorName)),
      hasMore: page.hasMore,
    };
  }

  /**
   * An agent opened the conversation (or it is open while new messages arrive): clears its unread
   * count for the team and sends a read receipt to the customer's widget.
   */
  async markAgentRead(tenantId: string, conversationId: string): Promise<ConversationSummary> {
    const readAt = new Date();
    const updated = await this.db
      .update(conversations)
      .set({ agentReadAt: readAt })
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .returning({ id: conversations.id });
    if (updated.length === 0) throw new NotFoundException('Conversation not found');
    this.realtime.visitorReadReceipt(conversationId, readAt.toISOString());
    const summary = await this.publish(tenantId, conversationId);
    if (!summary) throw new NotFoundException('Conversation not found');
    return summary;
  }

  /** The visitor has the chat open: agents see "Seen" under their replies. */
  async markVisitorRead(tenantId: string, visitorId: string, conversationId: string) {
    const updated = await this.db
      .update(conversations)
      .set({ visitorReadAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.tenantId, tenantId),
          eq(conversations.visitorId, visitorId),
        ),
      )
      .returning({ id: conversations.id });
    if (updated.length > 0) await this.publish(tenantId, conversationId);
    return updated.length > 0;
  }

  toAgentMessage(row: MessageRow, authorName: string | null = null): AgentMessage {
    return {
      id: row.id,
      sender: row.sender,
      content: row.content,
      sources: row.sources,
      createdAt: row.createdAt.toISOString(),
      confidence: row.confidence,
      needsHuman: row.needsHuman,
      authorName,
    };
  }

  /** Store a message, then push it to dashboards (and to the widget unless it is internal). */
  async addMessage(
    tenantId: string,
    conversationId: string,
    input: { sender: MessageSender; content: string; userId?: string },
  ): Promise<AgentMessage> {
    const [row] = await this.db
      .insert(messages)
      .values({
        tenantId,
        conversationId,
        sender: input.sender,
        content: input.content,
        userId: input.userId ?? null,
      })
      .returning();
    await this.db
      .update(conversations)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
    let authorName: string | null = null;
    if (input.userId) {
      const author = await this.db.query.users.findFirst({
        where: eq(users.id, input.userId),
        columns: { name: true },
      });
      authorName = author?.name ?? null;
    }
    const message = this.toAgentMessage(row!, authorName);
    if (input.sender === 'agent') {
      const forVisitor: HistoryMessage = {
        id: message.id,
        sender: 'agent',
        content: message.content,
        sources: [],
        createdAt: message.createdAt,
      };
      this.realtime.visitorMessage(conversationId, forVisitor);
    }
    this.realtime.agentMessage(tenantId, conversationId, message);
    await this.publish(tenantId, conversationId);
    return message;
  }

  /** Called by ChatService for customer messages and AI answers. */
  async messageStored(tenantId: string, row: MessageRow): Promise<void> {
    const summary = await this.publish(tenantId, row.conversationId);
    if (summary) this.realtime.agentMessage(tenantId, row.conversationId, this.toAgentMessage(row));
  }

  /** Push the conversation's current summary to the tenant's dashboards. */
  async publish(tenantId: string, conversationId: string): Promise<ConversationSummary | null> {
    const summary = await this.summary(tenantId, conversationId);
    if (summary) this.realtime.conversationChanged(tenantId, summary);
    return summary;
  }
}
