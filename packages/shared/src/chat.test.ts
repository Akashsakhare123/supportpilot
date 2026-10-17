import { describe, expect, it } from 'vitest';
import { chatRequestSchema, createChatStreamParser, playgroundChatSchema } from './chat';

describe('chatRequestSchema', () => {
  const valid = { key: 'pk_test_demo', visitorId: 'v_abc12345', message: '  Hi there ' };

  it('accepts a widget message and trims it', () => {
    expect(chatRequestSchema.parse(valid).message).toBe('Hi there');
  });

  it('rejects empty or huge messages, bad visitor ids and unknown fields', () => {
    expect(chatRequestSchema.safeParse({ ...valid, message: '   ' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...valid, message: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(chatRequestSchema.safeParse({ ...valid, visitorId: 'short' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...valid, visitorId: '../../etc' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...valid, tenantId: 'x' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...valid, conversationId: 'nope' }).success).toBe(false);
  });

  it('playground requests carry only a message and optional conversation', () => {
    expect(playgroundChatSchema.safeParse({ message: 'Hi' }).success).toBe(true);
    expect(playgroundChatSchema.safeParse({ message: 'Hi', key: 'pk' }).success).toBe(false);
  });
});

describe('createChatStreamParser', () => {
  it('returns complete events across arbitrary chunk boundaries', () => {
    const feed = createChatStreamParser();
    const body =
      'event: meta\ndata: {"conversationId":"c1"}\n\nevent: delta\ndata: {"text":"Hel"}\n\n' +
      'event: delta\r\ndata: {"text":"lo"}\r\n\r\n: keep-alive\n\nevent: done\ndata: {"content":"Hello"}\n\n';
    const events = [body.slice(0, 7), body.slice(7, 50), body.slice(50)].flatMap(feed);
    expect(events.map((e) => e.event)).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(events[2]).toEqual({ event: 'delta', data: { text: 'lo' } });
  });
});
