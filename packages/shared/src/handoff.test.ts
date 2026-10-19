import { describe, expect, it } from 'vitest';
import type { ConversationStatus } from './chat';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  offlineEmailSchema,
} from './handoff';

const ALL: ConversationStatus[] = ['ai', 'waiting', 'human', 'closed'];
const VALID = new Set([
  'ai>waiting',
  'ai>human',
  'ai>closed',
  'waiting>human',
  'waiting>ai',
  'waiting>closed',
  'human>ai',
  'human>closed',
]);

describe('conversation state machine', () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const valid = VALID.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${valid ? 'allowed' : 'refused'}`, () => {
        expect(canTransition(from, to)).toBe(valid);
        if (valid) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      });
    }
  }

  it('explains why a closed conversation cannot change', () => {
    expect(() => assertTransition('closed', 'ai')).toThrow('This conversation is closed');
    expect(() => assertTransition('human', 'waiting')).toThrow(
      'cannot go from "human" to "waiting"',
    );
  });
});

describe('offlineEmailSchema', () => {
  const conversationId = '6f1c1a9e-2c1d-4f7e-9a51-0e6c1f1f2a10';
  it('normalises a valid email and rejects junk', () => {
    expect(offlineEmailSchema.parse({ conversationId, email: ' Jane@Example.COM ' }).email).toBe(
      'jane@example.com',
    );
    expect(offlineEmailSchema.safeParse({ conversationId, email: 'nope' }).success).toBe(false);
  });
});
