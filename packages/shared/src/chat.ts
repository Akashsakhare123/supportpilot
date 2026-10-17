import { z } from 'zod';

export const CHAT_LIMITS = {
  messageMaxChars: 2_000,
  /** Previous messages sent to the model as conversation memory. */
  historyMessages: 6,
  /** Chunks retrieved per question. */
  topK: 5,
} as const;

export const conversationStatuses = ['ai', 'waiting', 'human', 'closed'] as const;
export type ConversationStatus = (typeof conversationStatuses)[number];

export const messageSenders = ['customer', 'ai', 'agent', 'system'] as const;
export type MessageSender = (typeof messageSenders)[number];

const message = z
  .string()
  .trim()
  .min(1, 'Type a message')
  .max(
    CHAT_LIMITS.messageMaxChars,
    `Messages are limited to ${CHAT_LIMITS.messageMaxChars} characters`,
  );

/** Body of POST /v1/chat (called by widget.js with the tenant's public key). */
export const chatRequestSchema = z
  .object({
    key: z.string().min(1),
    /** Anonymous, random id the widget keeps per browser; ties a visitor to their conversations. */
    visitorId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/, 'visitorId must be 8-64 letters, digits, _ or -'),
    conversationId: z.string().uuid().optional(),
    message,
  })
  .strict();
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** Body of POST /chat/playground (signed-in admin testing their own knowledge base). */
export const playgroundChatSchema = z
  .object({ conversationId: z.string().uuid().optional(), message })
  .strict();
export type PlaygroundChatRequest = z.infer<typeof playgroundChatSchema>;

/** A knowledge-base passage an answer is based on. */
export interface ChatSource {
  /** Citation number used in the answer text ("[1]"). */
  ref: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  headingPath: string[];
  /** First ~200 characters of the passage. */
  snippet: string;
  similarity: number;
}

/** Final event of an answer stream. */
export interface ChatDone {
  conversationId: string;
  messageId: string | null;
  content: string;
  sources: ChatSource[];
  /** 0-1, see ARCHITECTURE.md "Confidence score". */
  confidence: number;
  /** Low confidence or the customer asked for a person; T10 routes it to the agent inbox. */
  needsHuman: boolean;
  conversationStatus: ConversationStatus;
}

/**
 * Server-Sent Events of POST /v1/chat, in order: one `meta`, any number of `delta`, then `done`
 * (or `error`).
 */
export type ChatStreamEvent =
  | { event: 'meta'; data: { conversationId: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: ChatDone }
  | { event: 'error'; data: { message: string } };

/**
 * Incremental parser for the chat SSE stream (dashboard playground, widget): feed it decoded
 * text as it arrives; it returns the complete events seen so far.
 */
export function createChatStreamParser(): (text: string) => ChatStreamEvent[] {
  let buffer = '';
  return (text) => {
    buffer += text.replace(/\r\n/g, '\n');
    const events: ChatStreamEvent[] = [];
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: ?(.*)$/m.exec(block)?.[1]?.trim();
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (name && data) {
        try {
          events.push({ event: name, data: JSON.parse(data) } as ChatStreamEvent);
        } catch {
          // Ignore malformed blocks.
        }
      }
      end = buffer.indexOf('\n\n');
    }
    return events;
  };
}
