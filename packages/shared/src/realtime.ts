import { z } from 'zod';
import {
  CHAT_LIMITS,
  type ChatDone,
  type ChatSource,
  type ConversationStatus,
  type MessageSender,
} from './chat';

/** Socket.io namespace the widget connects to (the agent namespace follows in T09). */
export const WIDGET_NAMESPACE = '/widget';

export const WIDGET_LIMITS = {
  /** Customer messages per connection per minute (abuse / cost protection). */
  messagesPerMinute: 20,
  /** Messages returned when the widget reloads a conversation. */
  historyMessages: 50,
} as const;

const visitorId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'visitorId must be 8-64 letters, digits, _ or -');

/** Sent in the Socket.io handshake (`io(url, { auth })`). */
export const widgetAuthSchema = z.object({ key: z.string().min(1), visitorId });
export type WidgetAuth = z.infer<typeof widgetAuthSchema>;

export const widgetSendSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(CHAT_LIMITS.messageMaxChars),
  })
  .strict();
export type WidgetSend = z.infer<typeof widgetSendSchema>;

export const widgetHistorySchema = z.object({ conversationId: z.string().uuid() }).strict();

export interface HistoryMessage {
  id: string;
  sender: MessageSender;
  content: string;
  sources: ChatSource[];
  createdAt: string;
}

export type WidgetErrorCode =
  | 'invalid'
  | 'rate_limited'
  | 'busy'
  | 'conversation_not_found'
  | 'server_error';

/** Events the API sends to the widget. */
export interface WidgetServerEvents {
  /** A message the widget did not stream itself, e.g. an agent reply. */
  'message:new': (payload: { conversationId: string; message: HistoryMessage }) => void;
  /** An agent joined or the conversation changed state. */
  'conversation:status': (payload: {
    conversationId: string;
    status: ConversationStatus;
    agentName: string | null;
    /** For status "waiting": false means nobody can reply now, so the widget asks for an email. */
    agentsOnline?: boolean;
  }) => void;
  'message:delta': (payload: { conversationId: string; text: string }) => void;
  'message:done': (payload: ChatDone) => void;
  'message:error': (payload: { code: WidgetErrorCode; message: string }) => void;
}

/** Events the widget sends to the API (acknowledged). */
export interface WidgetClientEvents {
  'message:send': (
    payload: WidgetSend,
    ack: (
      result:
        | { ok: true; conversationId: string }
        | { ok: false; code: WidgetErrorCode; message: string },
    ) => void,
  ) => void;
  'ticket:email': (
    payload: { conversationId: string; email: string },
    ack: (result: { ok: true } | { ok: false; code: WidgetErrorCode; message: string }) => void,
  ) => void;
  'conversation:history': (
    payload: { conversationId: string },
    ack: (
      result:
        | { ok: true; messages: HistoryMessage[] }
        | { ok: false; code: WidgetErrorCode; message: string },
    ) => void,
  ) => void;
}

// ---------------------------------------------------------------------------------------------
// Agent dashboard (T09): commands go over REST, live updates come over the /agent namespace.

export const AGENT_NAMESPACE = '/agent';

export const inboxTabs = ['needs_agent', 'mine', 'team', 'ai', 'closed'] as const;
export type InboxTab = (typeof inboxTabs)[number];

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  needs_agent: 'Needs agent',
  mine: 'Mine',
  team: 'Other agents',
  ai: 'AI-handled',
  closed: 'Closed',
};

export const agentReplySchema = z
  .object({ message: z.string().trim().min(1).max(CHAT_LIMITS.messageMaxChars) })
  .strict();
export type AgentReply = z.infer<typeof agentReplySchema>;

/** One row of the inbox list. */
export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  visitorLabel: string;
  origin: string | null;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  lastMessage: { sender: MessageSender; content: string; createdAt: string } | null;
  /** Confidence of the latest AI answer, if any. */
  lastConfidence: number | null;
  lowConfidenceStreak: number;
  /** Why it is waiting for a person (status "waiting"). */
  handoffReason: string | null;
  /** Left by the customer when no agent was online: follow up by email. */
  contactEmail: string | null;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

/** A message as agents see it (adds AI confidence and the hand-off flag). */
export interface AgentMessage extends HistoryMessage {
  confidence: number | null;
  needsHuman: boolean;
  authorName: string | null;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: AgentMessage[];
}

export interface InboxList {
  items: ConversationSummary[];
  counts: Record<InboxTab, number>;
}

/** Which inbox tab a conversation belongs to for this agent (same rules as the API's filters). */
export function inboxTabFor(
  c: Pick<ConversationSummary, 'status' | 'assignedAgentId' | 'lowConfidenceStreak'>,
  userId: string,
): InboxTab {
  if (c.status === 'closed') return 'closed';
  if (c.status === 'human') return c.assignedAgentId === userId ? 'mine' : 'team';
  if (c.status === 'waiting' || c.lowConfidenceStreak > 0) return 'needs_agent';
  return 'ai';
}

/** Events the API sends to dashboards (room tenant:{id}). */
export interface AgentServerEvents {
  'conversation:upsert': (summary: ConversationSummary) => void;
  'message:new': (payload: { conversationId: string; message: AgentMessage }) => void;
  'document:status': (payload: {
    documentId: string;
    status: 'queued' | 'processing' | 'ready' | 'failed';
    error: string | null;
    chunkCount: number;
  }) => void;
}

/** Dashboards send no socket events: commands (claim, reply) go over REST. */
export type AgentClientEvents = Record<string, never>;
