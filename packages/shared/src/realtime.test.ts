import { describe, expect, it } from 'vitest';
import { widgetAuthSchema, widgetHistorySchema, widgetSendSchema } from './realtime';

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
