import { z } from 'zod';
import { CHAT_LIMITS, type ChatDone, type ChatSource, type MessageSender } from './chat';

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
  'conversation:history': (
    payload: { conversationId: string },
    ack: (
      result:
        | { ok: true; messages: HistoryMessage[] }
        | { ok: false; code: WidgetErrorCode; message: string },
    ) => void,
  ) => void;
}
