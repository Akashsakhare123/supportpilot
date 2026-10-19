// Type-only imports from @supportpilot/shared keep zod out of the bundle.
import type { ChatSource, HistoryMessage, WidgetConfig } from '@supportpilot/shared';
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
  id: string;
  role: 'customer' | 'ai' | 'agent' | 'notice';
  text: string;
  sources?: ChatSource[];
  pending?: boolean;
}

const HUMAN_REQUEST = "I'd like to talk to a person, please.";
let counter = 0;
const localId = () => `l${++counter}`;

function fromHistory(m: HistoryMessage): Line {
  return {
    id: m.id,
    role: m.sender === 'customer' ? 'customer' : m.sender === 'agent' ? 'agent' : 'ai',
    text: m.content,
    sources: m.sources,
  };
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
  const [unread, setUnread] = useState(false);
  const openRef = useRef(false);
  const socket = useRef<WidgetSocket | null>(null);
  const pendingId = useRef<string | null>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const conversationKey = `sp_conversation_${publicKey}`;

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

  /** Connect on first open (no sockets on pages where nobody uses the chat). */
  useEffect(() => {
    if (!open || socket.current) return;
    const s = connectWidget(apiUrl, publicKey, visitorIdFor(publicKey));
    socket.current = s;
    setConnection('connecting');

    s.on('connect', () => {
      setConnection('online');
      const saved = load(conversationKey);
      if (!saved) return;
      s.emit('conversation:history', { conversationId: saved }, (result) => {
        if (result.ok) setLines(result.messages.map(fromHistory));
        else save(conversationKey, null); // gone or not ours: start fresh
      });
    });
    s.on('disconnect', () => {
      setConnection('reconnecting');
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
      update(id, { text: done.content, sources: done.sources, pending: false });
    });
    // Agent replies (and other messages this widget did not stream itself).
    s.on('message:new', ({ conversationId, message }) => {
      if (conversationId !== load(conversationKey)) return;
      setLines((all) =>
        all.some((line) => line.id === message.id) ? all : [...all, fromHistory(message)],
      );
      if (!openRef.current) setUnread(true);
    });
    s.on('conversation:status', ({ conversationId, status, agentName }) => {
      if (conversationId !== load(conversationKey)) return;
      if (status === 'human') {
        notice(`${agentName ?? 'A team member'} from our team joined the chat.`);
      }
    });
    s.on('message:error', ({ message }) => {
      if (pendingId.current) {
        update(pendingId.current, { pending: false, text: message, role: 'notice' });
        pendingId.current = null;
      } else notice(message);
      setBusy(false);
    });
    return undefined;
  }, [open, apiUrl, publicKey, conversationKey, update, notice]);

  useEffect(() => () => void socket.current?.disconnect(), []);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' });
  }, [lines, open]);

  useEffect(() => {
    openRef.current = open;
    if (open) {
      setUnread(false);
      input.current?.focus();
    }
  }, [open]);

  function send(text: string) {
    const message = text.trim();
    const s = socket.current;
    if (!message || busy || !s || connection !== 'online') return;
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
            <span class="sp-title">{tenantName}</span>
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
            <div class="sp-line sp-ai">
              <p class="sp-bubble">{branding.greeting}</p>
            </div>
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
              </div>
            ))}
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
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
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
        {unread && !open && <span class="sp-unread" aria-label="New message" />}
      </button>
    </div>
  );
}
