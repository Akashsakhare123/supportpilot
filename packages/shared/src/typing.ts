// No zod and no other imports: the widget bundles this file (`@supportpilot/shared/typing`).

/** Typing indicator timing, the same on both sides of the chat. */
export const TYPING = {
  /** While someone keeps typing, repeat typing:start at most this often. */
  throttleMs: 2_000,
  /** No keystroke for this long sends typing:stop. */
  idleMs: 3_000,
  /** The receiver hides the indicator if neither a repeat nor a stop arrives in time. */
  expireMs: 6_000,
} as const;

export interface TypingNotifier {
  /** Call on every keystroke. Sends `true` at once, then at most once per throttle window. */
  keystroke(): void;
  /** Call when the message is sent or the input is cleared: sends `false` if needed. */
  stop(): void;
  /** Cancel timers without sending anything (component unmount, conversation change). */
  dispose(): void;
}

/**
 * Throttled typing:start / typing:stop for one input. A stop is only sent after a start, so an
 * idle input sends nothing; a typing person sends one event every two seconds, not one per key.
 */
export function createTypingNotifier(
  emit: (typing: boolean) => void,
  options: { throttleMs?: number; idleMs?: number; now?: () => number } = {},
): TypingNotifier {
  const throttleMs = options.throttleMs ?? TYPING.throttleMs;
  const idleMs = options.idleMs ?? TYPING.idleMs;
  const now = options.now ?? Date.now;
  let lastStart = 0;
  let typing = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stop = () => {
    clearIdle();
    if (!typing) return;
    typing = false;
    lastStart = 0;
    emit(false);
  };

  return {
    keystroke() {
      const t = now();
      if (!typing || t - lastStart >= throttleMs) {
        typing = true;
        lastStart = t;
        emit(true);
      }
      clearIdle();
      idleTimer = setTimeout(stop, idleMs);
    },
    stop,
    dispose() {
      clearIdle();
      typing = false;
    },
  };
}
