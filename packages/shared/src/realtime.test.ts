import { describe, expect, it } from 'vitest';
import {
  agentReplySchema,
  combinePresence,
  inboxTabFor,
  messagePageQuerySchema,
  presenceSetSchema,
  typingSchema,
  widgetAuthSchema,
  widgetHistorySchema,
  widgetSendSchema,
} from './realtime';

describe('widget socket schemas', () => {
  it('validates the handshake', () => {
    expect(
      widgetAuthSchema.safeParse({ key: 'pk_test_demo', visitorId: 'v_12345678' }).success,
    ).toBe(true);
    expect(widgetAuthSchema.safeParse({ key: 'pk_test_demo', visitorId: 'x' }).success).toBe(false);
    expect(widgetAuthSchema.safeParse({ visitorId: 'v_12345678' }).success).toBe(false);
  });

  it('validates messages and history requests', () => {
    expect(widgetSendSchema.parse({ message: '  hi ' }).message).toBe('hi');
    expect(widgetSendSchema.safeParse({ message: '' }).success).toBe(false);
    expect(widgetSendSchema.safeParse({ message: 'hi', tenantId: 'x' }).success).toBe(false);
    expect(widgetHistorySchema.safeParse({ conversationId: 'nope' }).success).toBe(false);
  });
});

describe('inboxTabFor', () => {
  const base = { status: 'ai' as const, assignedAgentId: null, lowConfidenceStreak: 0 };
  it('sorts conversations into the inbox tabs', () => {
    expect(inboxTabFor(base, 'me')).toBe('ai');
    expect(inboxTabFor({ ...base, lowConfidenceStreak: 1 }, 'me')).toBe('needs_agent');
    expect(inboxTabFor({ ...base, status: 'waiting' }, 'me')).toBe('needs_agent');
    expect(inboxTabFor({ ...base, status: 'human', assignedAgentId: 'me' }, 'me')).toBe('mine');
    expect(inboxTabFor({ ...base, status: 'human', assignedAgentId: 'you' }, 'me')).toBe('team');
    expect(inboxTabFor({ ...base, status: 'closed', assignedAgentId: 'me' }, 'me')).toBe('closed');
  });

  it('validates agent replies', () => {
    expect(agentReplySchema.safeParse({ message: ' ok ' }).success).toBe(true);
    expect(agentReplySchema.safeParse({ message: '' }).success).toBe(false);
  });
});

describe('T11 live chat contract', () => {
  const id = '6f1c2f0e-7a8b-4c1d-9e2f-0a1b2c3d4e5f';

  it('validates typing, presence and history paging', () => {
    expect(typingSchema.safeParse({ conversationId: id, typing: true }).success).toBe(true);
    expect(typingSchema.safeParse({ conversationId: 'x', typing: true }).success).toBe(false);
    expect(typingSchema.safeParse({ conversationId: id, typing: 'yes' }).success).toBe(false);
    expect(presenceSetSchema.safeParse({ state: 'away' }).success).toBe(true);
    expect(presenceSetSchema.safeParse({ state: 'offline' }).success).toBe(false);
    expect(widgetHistorySchema.safeParse({ conversationId: id, before: id }).success).toBe(true);
    expect(
      widgetHistorySchema.safeParse({ conversationId: id, before: id, after: id }).success,
    ).toBe(false);
    expect(messagePageQuerySchema.parse({ limit: '20' }).limit).toBe(20);
    expect(messagePageQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('combines the presence of several tabs', () => {
    expect(combinePresence(['away', 'online'])).toBe('online');
    expect(combinePresence(['away'])).toBe('away');
    expect(combinePresence([])).toBe('offline');
  });
});
