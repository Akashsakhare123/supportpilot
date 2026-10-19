// Type-only imports from @supportpilot/shared keep zod out of the bundle; the typing helper comes
// from the zod-free `@supportpilot/shared/typing` entry.
import type { ChatSource, HistoryMessage, WidgetConfig } from '@supportpilot/shared';
import { createTypingNotifier, TYPING, type TypingNotifier } from '@supportpilot/shared/typing';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { connectWidget, type WidgetSocket } from './connection';
import { load, save, visitorIdFor } from './storage';

export interface AppProps {
  publicKey: string;
  apiUrl: string;
}

type Load = { state: 'loading' } | { state: 'ready'; config: WidgetConfig } | { state: 'off' };
type Connection = 'idle' | 'connecting' | 'online' | 'reconnecting';

interface Line {
  /** Server message id, or a local id ("l1") until the server's id is known. */
  id: string;
  role: 'customer' | 'ai' | 'agent' | 'notice';
  text: string;
  sources?: ChatSource[];
  pending?: boolean;
  createdAt?: string;
  /** Customer message an agent has read (read receipt). */
  seen?: boolean;
}

const HUMAN_REQUEST = "I'd like to talk to a person, please.";
let counter = 0;
const localId = () => `l${++counter}`;
const isLocal = (id: string) => /^l\d+$/.test(id);

function fromHistory(m: HistoryMessage): Line {
  return {
    id: m.id,
    role: m.sender === 'customer' ? 'customer' : m.sender === 'agent' ? 'agent' : 'ai',
    text: m.content,
    sources: m.sources,
    createdAt: m.createdAt,
  };
}

/**
 * Add messages from the server without duplicates. A customer message the widget showed
 * before the server stored it (local id) takes over the server id instead of appearing twice.
 */
function merge(lines: Line[], incoming: HistoryMessage[]): Line[] {
  const next = [...lines];
  for (const m of incoming) {
    if (next.some((line) => line.id === m.id)) continue;
    const local =
      m.sender === 'customer' &&
      next.findIndex((l) => l.role === 'customer' && isLocal(l.id) && l.text === m.content);
    if (typeof local === 'number' && local >= 0) {
      next[local] = { ...next[local]!, id: m.id, createdAt: m.createdAt };
    } else next.push(fromHistory(m));
  }
  return next;
}

/** Latest message id the server knows, for "send me what I missed" after a reconnect. */
function lastServerId(lines: Line[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.role !== 'notice' && !line.pending && !isLocal(line.id)) return line.id;
  }
  return null;
}

function ChatIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.6c-.3.3-.8 0-.8-.4V5.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Sources({ sources }: { sources: ChatSource[] }) {
  if (!sources.length) return null;
  return (
    <div class="sp-sources">
      <span>Sources:</span>
      {sources.map((s) =>
        s.documentUrl ? (
          <a key={s.chunkId} href={s.documentUrl} target="_blank" rel="noopener noreferrer">
            [{s.ref}] {s.documentTitle}
          </a>
        ) : (
          <span key={s.chunkId} class="sp-source">
            [{s.ref}] {s.documentTitle}
          </span>
        ),
      )}
    </div>
  );
}

export function App({ publicKey, apiUrl }: AppProps) {
  const [open, setOpen] = useState(false);
  const [load_, setLoad] = useState<Load>({ state: 'loading' });
  const [lines, setLines] = useState<Line[]>([]);
  const [connection, setConnection] = useState<Connection>('idle');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const [askEmail, setAskEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [agentsOnline, setAgentsOnline] = useState<boolean | null>(null);
  const [agentTyping, setAgentTyping] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const openRef = useRef(false);
  const linesRef = useRef<Line[]>([]);
  const socket = useRef<WidgetSocket | null>(null);
  const pendingId = useRef<string | null>(null);
  const typingNotifier = useRef<TypingNotifier | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepScroll = useRef(false);
  const listEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const conversationKey = `sp_conversation_${publicKey}`;
  linesRef.current = lines;

  useEffect(() => {
    fetch(`${apiUrl}/widget/config?key=${encodeURIComponent(publicKey)}`)
      .then(async (res) => {
        if (!res.ok) {
          // 403: this website is not in the tenant's allowed domains. 404: unknown or rotated key.
          console.warn(
            `[SupportPilot] Widget disabled (${res.status}). Check the key and allowed domains.`,
          );
          setLoad({ state: 'off' });
          return;
        }
        setLoad({ state: 'ready', config: (await res.json()) as WidgetConfig });
      })
      .catch(() => {
        console.warn('[SupportPilot] Could not reach the SupportPilot API.');
        setLoad({ state: 'off' });
      });
  }, [apiUrl, publicKey]);

  const update = useCallback((id: string, patch: Partial<Line>) => {
    setLines((all) => all.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }, []);

  const notice = useCallback((text: string) => {
    setLines((all) => [...all, { id: localId(), role: 'notice', text }]);
  }, []);

  /** Read receipt: the visitor has the chat open, so the agent can see "Seen". */
  const markRead = useCallback(() => {
    const conversationId = load(conversationKey);
    const s = socket.current;
    if (!openRef.current || !conversationId || !s?.connected) return;
    s.emit('conversation:read', { conversationId });
  }, [conversationKey]);

  const showAgentTyping = useCallback((name: string | null) => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    setAgentTyping(name);
    // A lost "stop" (closed tab) must not leave the dots forever.
    if (name) typingTimer.current = setTimeout(() => setAgentTyping(null), TYPING.expireMs);
  }, []);

  /**
   * Connect when the chat is first opened, or right away for a visitor with an ongoing
   * conversation (so agent replies arrive with an unread badge). No socket on pages where nobody
   * has used the chat.
   */
  const shouldConnect = open || (load_.state === 'ready' && load(conversationKey) !== null);
  useEffect(() => {
    if (!shouldConnect || socket.current) return;
    const s = connectWidget(apiUrl, publicKey, visitorIdFor(publicKey));
    socket.current = s;
    setConnection('connecting');

    const restore = (conversationId: string) => {
      const after = linesRef.current.length ? lastServerId(linesRef.current) : null;
      s.emit(
        'conversation:history',
        after ? { conversationId, after, limit: 100 } : { conversationId },
        (result) => {
          if (!result.ok) {
            if (result.code === 'conversation_not_found') save(conversationKey, null);
            else if (after) setLines([]); // unknown cursor: start over with the latest page
            return;
          }
          if (after && result.hasMore) {
            // Missed too much while offline: reload the latest page instead.
            setLines([]);
            restore(conversationId);
            return;
          }
          const readAt = result.agentReadAt;
          setLines((all) =>
            merge(after ? all : [], result.messages).map((line) =>
              readAt && line.role === 'customer' && line.createdAt && line.createdAt <= readAt
                ? { ...line, seen: true }
                : line,
            ),
          );
          if (!after) setHasMore(result.hasMore);
          if (result.status === 'closed') {
            save(conversationKey, null);
            setAskEmail(false);
          }
          if (openRef.current) markRead();
          else setUnread(result.unread);
        },
      );
    };

    s.on('connect', () => {
      setConnection('online');
      const saved = load(conversationKey);
      if (saved) restore(saved);
    });
    s.on('disconnect', () => {
      setConnection('reconnecting');
      showAgentTyping(null);
      if (pendingId.current) {
        update(pendingId.current, { pending: false, text: 'Connection lost. Please ask again.' });
        pendingId.current = null;
        setBusy(false);
      }
    });
    s.on('connect_error', () => setConnection('reconnecting'));
    s.on('message:delta', ({ text }) => {
      const id = pendingId.current;
      if (!id) return;
      setLines((all) =>
        all.map((line) => (line.id === id ? { ...line, text: line.text + text } : line)),
      );
    });
    s.on('message:done', (done) => {
      const id = pendingId.current;
      pendingId.current = null;
      setBusy(false);
      if (!id) return;
      if (!done.messageId && !done.content) {
        // A person is handling this conversation; their replies arrive separately (T09).
        setLines((all) => all.filter((line) => line.id !== id));
        return;
      }
      update(id, {
        id: done.messageId ?? id,
        text: done.content,
        sources: done.sources,
        pending: false,
      });
    });
    // Agent replies (and other messages this widget did not stream itself).
    s.on('message:new', ({ conversationId, message }) => {
      if (conversationId !== load(conversationKey)) return;
      setLines((all) => merge(all, [message]));
      if (message.sender === 'agent') showAgentTyping(null);
      if (openRef.current) markRead();
      else setUnread((n) => n + 1);
    });
    s.on('typing', ({ conversationId, typing, name }) => {
      if (conversationId !== load(conversationKey)) return;
      showAgentTyping(typing ? (name ?? 'Our team') : null);
    });
    s.on('presence', ({ agentsOnline: online }) => setAgentsOnline(online));
    // An agent read the conversation: everything the customer sent so far is seen.
    s.on('conversation:read', ({ conversationId }) => {
      if (conversationId !== load(conversationKey)) return;
      setLines((all) =>
        all.map((line) => (line.role === 'customer' ? { ...line, seen: true } : line)),
      );
    });
    s.on('conversation:status', ({ conversationId, status, agentName, agentsOnline }) => {
      if (conversationId !== load(conversationKey)) return;
      if (status === 'human') {
        setAskEmail(false);
        notice(`${agentName ?? 'A team member'} from our team joined the chat.`);
      } else if (status === 'waiting') {
        if (agentsOnline === false) setAskEmail(true);
        else notice('Connecting you to a person from our team...');
      } else if (status === 'ai') {
        setAskEmail(false);
        showAgentTyping(null);
        notice("You're chatting with our AI assistant again.");
      } else if (status === 'closed') {
        setAskEmail(false);
        showAgentTyping(null);
        save(conversationKey, null); // the next question starts a new conversation
        notice('This conversation was closed. Ask a new question any time.');
      }
    });
    s.on('message:error', ({ message }) => {
      if (pendingId.current) {
        update(pendingId.current, { pending: false, text: message, role: 'notice' });
        pendingId.current = null;
      } else notice(message);
      setBusy(false);
    });

    typingNotifier.current = createTypingNotifier((typing) => {
      const conversationId = load(conversationKey);
      if (conversationId && s.connected) s.emit('typing', { conversationId, typing });
    });
    return undefined;
  }, [
    shouldConnect,
    apiUrl,
    publicKey,
    conversationKey,
    update,
    notice,
    markRead,
    showAgentTyping,
  ]);

  /** "Load earlier messages": the page before the oldest message shown. */
  function loadEarlier() {
    const conversationId = load(conversationKey);
    const oldest = lines.find((line) => line.role !== 'notice' && !isLocal(line.id));
    const s = socket.current;
    if (!conversationId || !oldest || !s || loadingMore) return;
    setLoadingMore(true);
    s.emit('conversation:history', { conversationId, before: oldest.id }, (result) => {
      setLoadingMore(false);
      if (!result.ok) return;
      keepScroll.current = true;
      setHasMore(result.hasMore);
      setLines((all) => [...result.messages.map(fromHistory), ...all]);
    });
  }

  useEffect(
    () => () => {
      typingNotifier.current?.dispose();
      socket.current?.disconnect();
    },
    [],
  );

  useEffect(() => {
    // Loading older messages keeps the reader where they are instead of jumping to the end.
    if (keepScroll.current) {
      keepScroll.current = false;
      return;
    }
    listEnd.current?.scrollIntoView({ block: 'end' });
  }, [lines, open, agentTyping]);

  useEffect(() => {
    openRef.current = open;
    if (open) {
      setUnread(0);
      markRead();
      input.current?.focus();
    }
  }, [open, markRead]);

  function send(text: string) {
    const message = text.trim();
    const s = socket.current;
    if (!message || busy || !s || connection !== 'online') return;
    typingNotifier.current?.stop();
    const answerId = localId();
    pendingId.current = answerId;
    setBusy(true);
    setDraft('');
    setLines((all) => [
      ...all,
      { id: localId(), role: 'customer', text: message },
      { id: answerId, role: 'ai', text: '', pending: true },
    ]);
    const conversationId = load(conversationKey) ?? undefined;
    s.emit('message:send', { message, conversationId }, (result) => {
      if (result.ok) {
        save(conversationKey, result.conversationId);
        return;
      }
      if (result.code === 'conversation_not_found') save(conversationKey, null);
      pendingId.current = null;
      setBusy(false);
      update(answerId, { pending: false, role: 'notice', text: result.message });
    });
  }

  if (load_.state !== 'ready') return null;
  const { branding, tenantName } = load_.config;
  const offline = connection === 'reconnecting' || connection === 'connecting';
  const lastCustomer = [...lines].reverse().find((line) => line.role === 'customer');

  return (
    <div
      class={`sp-root ${branding.position === 'left' ? 'sp-left' : ''}`}
      style={{ '--sp-brand': branding.primaryColor }}
    >
      {open && (
        <div
          class="sp-panel"
          role="dialog"
          aria-label={`${tenantName} support chat`}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <div class="sp-header">
            {branding.logoUrl && <img class="sp-logo" src={branding.logoUrl} alt="" />}
            <div class="sp-title">
              <span>{tenantName}</span>
              {agentsOnline !== null && (
                <span class="sp-presence">
                  <i class={agentsOnline ? 'sp-dot sp-dot-on' : 'sp-dot'} />
                  {agentsOnline ? 'Our team is online' : 'AI assistant · team offline'}
                </span>
              )}
            </div>
            <button
              class="sp-icon-button"
              type="button"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
          {offline && (
            <div class="sp-status" role="status">
              {connection === 'connecting' ? 'Connecting...' : 'Reconnecting...'}
            </div>
          )}
          <div class="sp-messages" aria-live="polite">
            {hasMore ? (
              <button class="sp-more" type="button" disabled={loadingMore} onClick={loadEarlier}>
                {loadingMore ? 'Loading...' : 'Load earlier messages'}
              </button>
            ) : (
              <div class="sp-line sp-ai">
                <p class="sp-bubble">{branding.greeting}</p>
              </div>
            )}
            {lines.map((line) => (
              <div key={line.id} class={`sp-line sp-${line.role}`}>
                {line.role === 'notice' ? (
                  <p class="sp-notice">{line.text}</p>
                ) : (
                  <div class="sp-bubble">
                    {line.role === 'agent' && <span class="sp-agent">Team member</span>}
                    {line.pending && !line.text ? (
                      <span class="sp-typing" aria-label="Typing">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <p>{line.text}</p>
                    )}
                    {line.sources && <Sources sources={line.sources} />}
                  </div>
                )}
                {line === lastCustomer && line.seen && <span class="sp-seen">Seen</span>}
              </div>
            ))}
            {agentTyping && (
              <div class="sp-line sp-agent-typing" role="status">
                <div class="sp-bubble">
                  <span class="sp-agent">{agentTyping} is typing</span>
                  <span class="sp-typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            )}
            {askEmail && (
              <form
                class="sp-email"
                onSubmit={(e) => {
                  e.preventDefault();
                  const conversationId = load(conversationKey);
                  if (!conversationId || !socket.current) return;
                  socket.current.emit(
                    'ticket:email',
                    { conversationId, email: email.trim() },
                    (result) => {
                      if (!result.ok) {
                        setEmailError(result.message);
                        return;
                      }
                      setAskEmail(false);
                      setEmailError(null);
                      notice(`Thanks! We'll reply to ${email.trim()} as soon as possible.`);
                    },
                  );
                }}
              >
                <label for="sp-email">Leave your email and we'll get back to you:</label>
                <div class="sp-email-row">
                  <input
                    id="sp-email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                  />
                  <button type="submit" class="sp-send">
                    Send
                  </button>
                </div>
                {emailError && <p class="sp-error">{emailError}</p>}
              </form>
            )}
            <div ref={listEnd} />
          </div>
          <form
            class="sp-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              ref={input}
              rows={1}
              value={draft}
              maxLength={2000}
              placeholder="Type your question..."
              aria-label="Message"
              onInput={(e) => {
                const value = (e.target as HTMLTextAreaElement).value;
                setDraft(value);
                if (value.trim()) typingNotifier.current?.keystroke();
                else typingNotifier.current?.stop();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            <button class="sp-send" type="submit" disabled={busy || offline || !draft.trim()}>
              Send
            </button>
          </form>
          <div class="sp-footer">
            <button
              class="sp-link"
              type="button"
              disabled={busy || offline}
              onClick={() => send(HUMAN_REQUEST)}
            >
              Talk to a person
            </button>
            <span>Answers are AI-generated from our help articles.</span>
          </div>
        </div>
      )}
      <button
        class="sp-launcher"
        type="button"
        aria-label={open ? 'Close support chat' : 'Open support chat'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
        {unread > 0 && !open && (
          <span class="sp-unread" aria-label={`${unread} new message${unread === 1 ? '' : 's'}`}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    </div>
  );
}
