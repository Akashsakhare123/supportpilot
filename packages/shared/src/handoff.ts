import { z } from 'zod';
import type { ConversationStatus } from './chat';

/**
 * Conversation state machine (ARCHITECTURE.md section 4). Every status change goes through
 * HandoffService, which checks it here first.
 *
 *   ai -> waiting        low confidence twice in a row, or the customer asks for a person
 *   ai | waiting -> human    an agent takes the conversation
 *   human | waiting -> ai    the agent hands it back to the AI
 *   ai | waiting | human -> closed   an agent closes it
 */
export const HANDOFF_TRANSITIONS: Record<ConversationStatus, readonly ConversationStatus[]> = {
  ai: ['waiting', 'human', 'closed'],
  waiting: ['human', 'ai', 'closed'],
  human: ['ai', 'closed'],
  closed: [],
};

export function canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  return HANDOFF_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ConversationStatus,
    readonly to: ConversationStatus,
  ) {
    super(
      from === 'closed'
        ? 'This conversation is closed'
        : `A conversation cannot go from "${from}" to "${to}"`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: ConversationStatus, to: ConversationStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export type HandoffReason = 'customer_request' | 'low_confidence';

export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  customer_request: 'Customer asked for a person',
  low_confidence: 'AI was not confident twice in a row',
};

/** Two low-confidence answers in a row hand the conversation to a person. */
export const LOW_CONFIDENCE_LIMIT = 2;

export const HANDOFF_THRESHOLD = { min: 0.2, max: 0.9, default: 0.55 } as const;

/** Offline ticket: the customer leaves an email when no agent is online. */
export const offlineEmailSchema = z
  .object({
    conversationId: z.string().uuid(),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  })
  .strict();
export type OfflineEmail = z.infer<typeof offlineEmailSchema>;
