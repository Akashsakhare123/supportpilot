import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTypingNotifier, TYPING } from './typing';

describe('createTypingNotifier', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends start at once, repeats at most once per throttle window, stops after idle', () => {
    const sent: boolean[] = [];
    const n = createTypingNotifier((typing) => sent.push(typing), { now: () => Date.now() });
    n.keystroke();
    expect(sent).toEqual([true]);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(150);
      n.keystroke();
    }
    expect(sent).toEqual([true]); // 1.5 s of typing: no repeat yet
    vi.advanceTimersByTime(600);
    n.keystroke();
    expect(sent).toEqual([true, true]); // past the 2 s throttle window
    vi.advanceTimersByTime(TYPING.idleMs);
    expect(sent).toEqual([true, true, false]);
  });

  it('stop() sends false only after a start; dispose() sends nothing', () => {
    const sent: boolean[] = [];
    const n = createTypingNotifier((typing) => sent.push(typing));
    n.stop();
    expect(sent).toEqual([]);
    n.keystroke();
    n.stop();
    n.stop();
    expect(sent).toEqual([true, false]);
    n.keystroke();
    n.dispose();
    vi.advanceTimersByTime(TYPING.idleMs * 2);
    expect(sent).toEqual([true, false, true]);
  });
});
