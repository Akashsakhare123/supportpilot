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
  /** Typing events per connection per 10 seconds; extra events are dropped silently. */
  typingPer10s: 20,
  /** Thumbs up / down clicks per connection per 10 seconds. */
  feedbackPer10s: 10,
} as const;

/** Page sizes for message history (widget and agent view). */
export const HISTORY_PAGE = { default: 50, max: 100 } as const;

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

const pageFields = {
  /** Older page: messages before this message id (scrolling up). */
  before: z.string().uuid().optional(),
  /** Missed messages: everything after this message id (reconnect sync). */
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(HISTORY_PAGE.max).optional(),
};
const oneCursor = (v: { before?: string; after?: string }) => !(v.before && v.after);
const oneCursorError = { message: 'Use either before or after, not both' };

/** Widget history request: the latest page, an older page (before) or missed messages (after). */
export const widgetHistorySchema = z
  .object({ conversationId: z.string().uuid(), ...pageFields })
  .strict()
  .refine(oneCursor, oneCursorError);
export type WidgetHistoryRequest = z.infer<typeof widgetHistorySchema>;

/** Query string of GET /conversations/:id/messages (agent view). */
export const messagePageQuerySchema = z.object(pageFields).refine(oneCursor, oneCursorError);
export type MessagePageQuery = z.infer<typeof messagePageQuerySchema>;

/** Typing indicator, sent by the widget and by dashboards (throttled, see TYPING). */
export const typingSchema = z
  .object({ conversationId: z.string().uuid(), typing: z.boolean() })
  .strict();
export type TypingInput = z.infer<typeof typingSchema>;

/** The widget tells the API the visitor has seen the conversation (read receipt). */
export const conversationReadSchema = z.object({ conversationId: z.string().uuid() }).strict();

/** The customer rates an AI answer (T12); `null` takes the rating back. */
export const messageFeedbackSchema = z
  .object({
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    feedback: z.enum(['up', 'down']).nullable(),
  })
  .strict();
export type MessageFeedbackInput = z.infer<typeof messageFeedbackSchema>;
export type MessageFeedback = 'up' | 'down';

export interface HistoryMessage {
  id: string;
  sender: MessageSender;
  content: string;
  sources: ChatSource[];
  createdAt: string;
  /** Thumbs up / down the customer gave this AI answer, if any. */
  feedback?: MessageFeedback | null;
}

/** A page of messages, oldest first. */
export interface MessagePage<T extends HistoryMessage = HistoryMessage> {
  messages: T[];
  /** More messages exist in the requested direction (older for the latest page / before). */
  hasMore: boolean;
}

/** What the widget needs to restore a conversation after a reload or reconnect. */
export interface WidgetHistory extends MessagePage {
  status: ConversationStatus;
  /** Agent replies the visitor has not seen yet (unread badge on the launcher). */
  unread: number;
  /** When an agent last read the conversation ("Seen" under the customer's messages). */
  agentReadAt: string | null;
}

export type WidgetErrorCode =
  'invalid' | 'rate_limited' | 'busy' | 'conversation_not_found' | 'server_error';

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
  /** The agent handling the conversation is typing (or stopped). */
  typing: (payload: { conversationId: string; typing: boolean; name: string | null }) => void;
  /** Sent on connect and whenever it changes: is anyone on the team available right now? */
  presence: (payload: { agentsOnline: boolean }) => void;
  /** An agent read the conversation (read receipt for the customer's messages). */
  'conversation:read': (payload: { conversationId: string; readAt: string }) => void;
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
    payload: WidgetHistoryRequest,
    ack: (
      result:
        ({ ok: true } & WidgetHistory) | { ok: false; code: WidgetErrorCode; message: string },
    ) => void,
  ) => void;
  /** Throttled on the client; no ack (fire and forget). */
  typing: (payload: TypingInput) => void;
  /** The visitor has the chat open and saw the latest messages. */
  'conversation:read': (payload: { conversationId: string }) => void;
  /** Thumbs up / down on one of the AI's answers in the visitor's own conversation. */
  'message:feedback': (
    payload: MessageFeedbackInput,
    ack: (result: { ok: true } | { ok: false; code: WidgetErrorCode; message: string }) => void,
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
  /** Customer messages no agent has read yet. */
  unreadCount: number;
  /** When the visitor last had the chat open (read receipt for agent replies). */
  visitorReadAt: string | null;
  lastMessageAt: string;
  createdAt: string;
}

/** A message as agents see it (adds AI confidence and the hand-off flag). */
export interface AgentMessage extends HistoryMessage {
  confidence: number | null;
  needsHuman: boolean;
  authorName: string | null;
}

export interface ConversationDetail extends MessagePage<AgentMessage> {
  conversation: ConversationSummary;
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

// ---------------------------------------------------------------------------------------------
// Presence (T11): each dashboard tab sends heartbeats; Redis keys with a TTL hold the state, so a
// crashed or closed tab goes offline by itself.

export const PRESENCE = {
  heartbeatMs: 10_000,
  /** A tab that misses three heartbeats is offline. */
  ttlSeconds: 30,
  /** How often each API instance looks for expired tabs and announces changes. */
  sweepMs: 5_000,
} as const;

export const presenceStates = ['online', 'away'] as const;
export type PresenceState = (typeof presenceStates)[number] | 'offline';

export const presenceSetSchema = z.object({ state: z.enum(presenceStates) }).strict();
export type PresenceSet = z.infer<typeof presenceSetSchema>;

export interface AgentPresence {
  userId: string;
  name: string;
  state: PresenceState;
}

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
};

/**
 * One state per agent from all of their open tabs: online wins over away (an agent with one
 * active tab is reachable), no live tab means offline.
 */
export function combinePresence(states: readonly PresenceState[]): PresenceState {
  if (states.includes('online')) return 'online';
  if (states.includes('away')) return 'away';
  return 'offline';
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
  /** Someone in a conversation is typing: the customer, or another agent. */
  typing: (payload: {
    conversationId: string;
    typing: boolean;
    from: 'customer' | 'agent';
    userId: string | null;
    name: string | null;
  }) => void;
  /** Every team member's presence; sent on connect and when anyone's state changes. */
  'presence:update': (payload: { agents: AgentPresence[] }) => void;
}

/**
 * Dashboards send only ephemeral signals over the socket (typing, presence); commands that change
 * data (claim, reply, read) go over REST.
 */
export interface AgentClientEvents {
  typing: (payload: TypingInput) => void;
  'presence:set': (payload: PresenceSet) => void;
  'presence:heartbeat': () => void;
}
