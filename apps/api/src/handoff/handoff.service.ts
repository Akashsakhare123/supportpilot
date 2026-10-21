import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  and,
  conversations,
  type ConversationRow,
  type Database,
  eq,
  sql,
  users,
} from '@supportpilot/db';
import {
  type AgentMessage,
  assertTransition,
  type ConversationStatus,
  type ConversationSummary,
  HANDOFF_REASON_LABELS,
  type HandoffReason,
  InvalidTransitionError,
} from '@supportpilot/shared';
import { DRIZZLE } from '../database/database.module';
import { InboxService } from '../inbox/inbox.service';
import { PresenceService } from '../realtime/presence.service';
import { RealtimeService } from '../realtime/realtime.service';

export const HANDOFF_TEXT = {
  connecting:
    "Of course. I'm connecting you with a person from our team; someone will join this chat shortly.",
  offline:
    "Our team isn't online right now. Leave your email below and we'll get back to you as soon as possible.",
} as const;

/**
 * Every conversation status change goes through here: request a person (ai -> waiting),
 * claim (-> human), hand back (-> ai), close (-> closed). Each change is checked against the
 * state machine in @supportpilot/shared, written with a guard on the current status (so two
 * concurrent changes cannot both win), logged as a system message and pushed live.
 */
@Injectable()
export class HandoffService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly inbox: InboxService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
  ) {}

  private async load(tenantId: string, conversationId: string): Promise<ConversationRow> {
    const row = await this.db.query.conversations.findFirst({
      where: and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)),
    });
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }

  private async agentName(userId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true },
    });
    return user?.name ?? 'An agent';
  }

  /**
   * Move a conversation from `from` to `to`, only if it is still in `from`. Returns false when
   * someone else changed it first.
   */
  private async move(
    tenantId: string,
    conversation: ConversationRow,
    to: ConversationStatus,
    set: Partial<ConversationRow>,
    extraGuard?: ReturnType<typeof sql>,
  ): Promise<boolean> {
    try {
      assertTransition(conversation.status, to);
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new ConflictException(error.message);
      throw error;
    }
    const updated = await this.db
      .update(conversations)
      .set({ ...set, status: to, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversation.id),
          eq(conversations.tenantId, tenantId),
          eq(conversations.status, conversation.status),
          extraGuard,
        ),
      )
      .returning({ id: conversations.id });
    return updated.length > 0;
  }

  /** Customer asked for a person, or the AI was unsure twice: ai -> waiting. */
  async requestHuman(
    tenantId: string,
    conversation: ConversationRow,
    reason: HandoffReason,
  ): Promise<{ status: ConversationStatus; agentsOnline: boolean }> {
    // Online agents only: someone who set themselves to "away" cannot pick it up now.
    const agentsOnline = (await this.presence.onlineCount(tenantId)) > 0;
    if (conversation.status !== 'ai') return { status: conversation.status, agentsOnline };
    const moved = await this.move(tenantId, conversation, 'waiting', {
      handoffReason: reason,
      firstHandoffAt: conversation.firstHandoffAt ?? new Date(),
    });
    if (!moved) return { status: conversation.status, agentsOnline };
    await this.inbox.addMessage(tenantId, conversation.id, {
      sender: 'system',
      content: `${HANDOFF_REASON_LABELS[reason]}. Waiting for an agent${agentsOnline ? '' : ' (no agent online)'}.`,
    });
    this.realtime.visitorStatus(conversation.id, 'waiting', null, agentsOnline);
    return { status: 'waiting', agentsOnline };
  }

  /**
   * Take a conversation (ai | waiting -> human). Exclusive: the UPDATE only succeeds while nobody
   * else is assigned, so of two agents clicking at once exactly one wins; the other gets 409.
   */
  async claim(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationSummary> {
    const current = await this.load(tenantId, conversationId);
    if (current.status === 'human' && current.assignedAgentId === userId) {
      return (await this.inbox.publish(tenantId, conversationId))!;
    }
    if (current.status === 'human') {
      const other = current.assignedAgentId ? await this.agentName(current.assignedAgentId) : null;
      throw new ConflictException(`Already taken by ${other ?? 'another agent'}`);
    }
    const won = await this.move(
      tenantId,
      current,
      'human',
      {
        assignedAgentId: userId,
        lowConfidenceStreak: 0,
        firstHandoffAt: current.firstHandoffAt ?? new Date(),
      },
      sql`${conversations.assignedAgentId} is null`,
    );
    if (!won) {
      const now = await this.load(tenantId, conversationId);
      const other = now.assignedAgentId ? await this.agentName(now.assignedAgentId) : null;
      throw new ConflictException(
        now.status === 'closed'
          ? 'This conversation is closed'
          : `Already taken by ${other ?? 'another agent'}`,
      );
    }
    const name = await this.agentName(userId);
    await this.inbox.addMessage(tenantId, conversationId, {
      sender: 'system',
      content: `${name} joined the conversation`,
    });
    this.realtime.visitorStatus(conversationId, 'human', name.split(' ')[0] ?? name);
    return (await this.inbox.publish(tenantId, conversationId))!;
  }

  /** Agent reply: takes an unassigned conversation first; refused if another agent has it. */
  async reply(
    tenantId: string,
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<AgentMessage> {
    const current = await this.load(tenantId, conversationId);
    if (current.status === 'closed') throw new ConflictException('This conversation is closed');
    if (current.status !== 'human' || current.assignedAgentId !== userId) {
      await this.claim(tenantId, userId, conversationId);
    }
    return this.inbox.addMessage(tenantId, conversationId, { sender: 'agent', content, userId });
  }

  /** Give the conversation back to the AI (human | waiting -> ai). Only the assigned agent or any
   * agent for an unassigned waiting conversation. */
  async handBack(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationSummary> {
    const current = await this.load(tenantId, conversationId);
    if (current.status === 'human' && current.assignedAgentId !== userId) {
      throw new ConflictException('Only the agent handling this conversation can hand it back');
    }
    const moved = await this.move(tenantId, current, 'ai', {
      assignedAgentId: null,
      lowConfidenceStreak: 0,
      handoffReason: null,
    });
    if (!moved) throw new ConflictException('The conversation changed; refresh and try again');
    const name = await this.agentName(userId);
    await this.inbox.addMessage(tenantId, conversationId, {
      sender: 'system',
      content: `${name} handed the conversation back to the AI assistant`,
    });
    this.realtime.visitorStatus(conversationId, 'ai', null);
    return (await this.inbox.publish(tenantId, conversationId))!;
  }

  /** End the conversation; the customer's next message starts a new one. */
  async close(
    tenantId: string,
    userId: string,
    conversationId: string,
  ): Promise<ConversationSummary> {
    const current = await this.load(tenantId, conversationId);
    if (current.status === 'human' && current.assignedAgentId !== userId) {
      throw new ConflictException('Only the agent handling this conversation can close it');
    }
    const moved = await this.move(tenantId, current, 'closed', {});
    if (!moved) throw new ConflictException('The conversation changed; refresh and try again');
    const name = await this.agentName(userId);
    await this.inbox.addMessage(tenantId, conversationId, {
      sender: 'system',
      content: `${name} closed the conversation`,
    });
    this.realtime.visitorStatus(conversationId, 'closed', null);
    return (await this.inbox.publish(tenantId, conversationId))!;
  }

  /** Offline ticket: the customer leaves an email while waiting with no agent online. */
  async saveContactEmail(
    tenantId: string,
    visitorId: string,
    conversationId: string,
    email: string,
  ): Promise<boolean> {
    const updated = await this.db
      .update(conversations)
      .set({ contactEmail: email, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.tenantId, tenantId),
          eq(conversations.visitorId, visitorId),
          sql`${conversations.status} <> 'closed'`,
        ),
      )
      .returning({ id: conversations.id });
    if (updated.length === 0) return false;
    await this.inbox.addMessage(tenantId, conversationId, {
      sender: 'system',
      content: `Customer left an email for follow-up: ${email}`,
    });
    return true;
  }
}
