'use client';

import {
  type AgentMessage,
  type ConversationDetail,
  type ConversationSummary,
  createTypingNotifier,
  HANDOFF_REASON_LABELS,
  type HandoffReason,
  INBOX_TAB_LABELS,
  type InboxList,
  type InboxTab,
  inboxTabFor,
  inboxTabs,
  type MessagePage,
  PRESENCE_LABELS,
  TYPING,
  type TypingNotifier,
} from '@supportpilot/shared';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { readError, useAuth } from '@/lib/auth';
import { useAgentEvent, useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<ConversationSummary['status'], string> = {
  ai: 'bg-slate-100 text-slate-700',
  waiting: 'bg-rose-100 text-rose-800',
  human: 'bg-emerald-100 text-emerald-800',
  closed: 'bg-slate-100 text-slate-500',
};
const STATUS_LABEL: Record<ConversationSummary['status'], string> = {
  ai: 'AI',
  waiting: 'Waiting',
  human: 'With agent',
  closed: 'Closed',
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function confidenceStyle(value: number): string {
  if (value >= 0.7) return 'bg-emerald-100 text-emerald-800';
  if (value >= 0.4) return 'bg-amber-100 text-amber-800';
  return 'bg-rose-100 text-rose-800';
}

const PRESENCE_DOT = { online: 'bg-emerald-500', away: 'bg-amber-400', offline: 'bg-slate-300' };

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Add messages without duplicates, keeping the order by time. */
function mergeMessages(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const known = new Set(current.map((m) => m.id));
  const added = incoming.filter((m) => !known.has(m.id));
  return added.length ? [...current, ...added] : current;
}

function MessageBubble({ message, seen }: { message: AgentMessage; seen?: boolean }) {
  if (message.sender === 'system') {
    return <p className="text-center text-xs text-slate-400">{message.content}</p>;
  }
  const mine = message.sender === 'agent';
  const customer = message.sender === 'customer';
  return (
    <div className={cn('flex', customer ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap',
          customer && 'bg-white text-slate-900 ring-1 ring-slate-200',
          message.sender === 'ai' && 'bg-slate-100 text-slate-900',
          mine && 'bg-brand text-white',
        )}
      >
        <p
          className={cn(
            'mb-0.5 text-[11px] font-semibold',
            mine ? 'text-white/80' : 'text-slate-500',
          )}
        >
          {customer ? 'Customer' : mine ? (message.authorName ?? 'Agent') : 'AI assistant'}
        </p>
        {message.content}
        {seen && <p className="mt-1 text-right text-[11px] text-white/80">Seen</p>}
        {message.sender === 'ai' && (
          <div className="mt-2 space-y-1 border-t border-slate-200 pt-2 text-xs text-slate-600">
            {message.sources.map((s) => (
              <p key={s.chunkId}>
                [{s.ref}] {s.documentTitle}
                {s.headingPath.length > 0 && ` > ${s.headingPath.join(' > ')}`}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              {message.confidence !== null && (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 font-medium',
                    confidenceStyle(message.confidence),
                  )}
                >
                  Confidence {Math.round(message.confidence * 100)}%
                </span>
              )}
              {message.needsHuman && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-800">
                  Needs a person
                </span>
              )}
              {message.feedback && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                  Customer rated {message.feedback === 'up' ? 'helpful' : 'not helpful'}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Live agent inbox: tabs with counts, conversation list, conversation view with reply box. */
export default function InboxPage() {
  const { user, apiFetch } = useAuth();
  const { connected, socket, team } = useRealtime();
  const [tab, setTab] = useState<InboxTab>('needs_agent');
  const [list, setList] = useState<InboxList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Who is typing, per conversation ("Customer" or an agent's first name). */
  const [typingIn, setTypingIn] = useState<Record<string, string>>({});
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const notifier = useRef<TypingNotifier | null>(null);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepScroll = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const userId = user?.id ?? '';

  // Deep link from Analytics (?c=<conversation id>) opens that conversation.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('c');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) setSelected(id);
  }, []);

  const loadList = useCallback(async () => {
    const res = await apiFetch(`/conversations?tab=${tab}`);
    if (res.ok) setList((await res.json()) as InboxList);
    else setError(await readError(res));
  }, [apiFetch, tab]);

  /** Read receipt + clear unread, only while the agent can actually see the conversation. */
  const markRead = useCallback(
    (id: string) => {
      if (!isVisible()) return;
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = setTimeout(() => {
        void apiFetch(`/conversations/${id}/read`, { method: 'POST' });
      }, 300);
    },
    [apiFetch],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/conversations/${id}`);
      if (res.ok) {
        setDetail((await res.json()) as ConversationDetail);
        markRead(id);
      } else setError(await readError(res));
    },
    [apiFetch, markRead],
  );

  /** After a reconnect: fetch only the messages missed since the last one shown. */
  const syncDetail = useCallback(
    async (id: string, lastId: string | undefined) => {
      if (!lastId) return loadDetail(id);
      const res = await apiFetch(`/conversations/${id}/messages?after=${lastId}&limit=100`);
      const page = res.ok ? ((await res.json()) as MessagePage<AgentMessage>) : null;
      // Unknown cursor or too much missed: reload the latest page instead.
      if (!page || page.hasMore) return loadDetail(id);
      setDetail((d) => (d ? { ...d, messages: mergeMessages(d.messages, page.messages) } : d));
      const summary = await apiFetch(`/conversations/${id}`);
      if (summary.ok) {
        const fresh = (await summary.json()) as ConversationDetail;
        setDetail((d) => (d ? { ...d, conversation: fresh.conversation } : d));
      }
    },
    [apiFetch, loadDetail],
  );

  async function loadEarlier() {
    const oldest = detail?.messages[0];
    if (!selected || !oldest || loadingMore) return;
    setLoadingMore(true);
    const res = await apiFetch(`/conversations/${selected}/messages?before=${oldest.id}`);
    if (res.ok) {
      const page = (await res.json()) as MessagePage<AgentMessage>;
      keepScroll.current = true;
      setDetail((d) =>
        d
          ? {
              ...d,
              hasMore: page.hasMore,
              messages: [
                ...page.messages.filter((m) => !d.messages.some((x) => x.id === m.id)),
                ...d.messages,
              ],
            }
          : d,
      );
    } else setError(await readError(res));
    setLoadingMore(false);
  }

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  // Several events can arrive at once (customer message + AI answer): reload the list once.
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void loadList(), 250);
  }, [loadList]);

  useAgentEvent('conversation:upsert', (summary) => {
    scheduleReload();
    if (summary.id === selected) {
      setDetail((d) => (d ? { ...d, conversation: summary } : d));
    }
  });

  useAgentEvent('message:new', ({ conversationId, message }) => {
    if (message.sender === 'customer' || message.sender === 'agent') {
      setTyping(conversationId, null);
    }
    if (conversationId !== selected) return;
    setDetail((d) => (d ? { ...d, messages: mergeMessages(d.messages, [message]) } : d));
    if (message.sender === 'customer') markRead(conversationId);
  });

  function setTyping(conversationId: string, who: string | null) {
    const timers = typingTimers.current;
    if (timers[conversationId]) clearTimeout(timers[conversationId]);
    delete timers[conversationId];
    setTypingIn((all) => {
      if (!who && !(conversationId in all)) return all;
      const next = { ...all };
      if (who) next[conversationId] = who;
      else delete next[conversationId];
      return next;
    });
    // A lost "stop" (closed tab) must not leave the indicator forever.
    if (who)
      timers[conversationId] = setTimeout(() => setTyping(conversationId, null), TYPING.expireMs);
  }

  useAgentEvent('typing', ({ conversationId, typing, from, name }) => {
    setTyping(
      conversationId,
      typing ? (from === 'customer' ? 'Customer' : (name ?? 'An agent')) : null,
    );
  });

  // Coming back to the tab counts as reading the open conversation.
  useEffect(() => {
    const onVisible = () => {
      if (selected && isVisible()) markRead(selected);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [selected, markRead]);

  // One typing notifier per open conversation; switching conversations sends "stopped typing".
  useEffect(() => {
    if (!selected || !socket) return;
    const n = createTypingNotifier((typing) =>
      socket.emit('typing', { conversationId: selected, typing }),
    );
    notifier.current = n;
    return () => {
      n.stop();
      notifier.current = null;
    };
  }, [selected, socket]);

  // After a reconnect, events may have been missed: reload the list and sync the open conversation.
  useEffect(() => {
    if (!connected) return;
    void loadList();
    if (selected) void syncDetail(selected, detail?.messages.at(-1)?.id);
    // Only when the connection state changes; selected / detail / loaders are read at that moment.
  }, [connected]);

  useEffect(() => {
    // Loading older messages keeps the agent where they are instead of jumping to the end.
    if (keepScroll.current) {
      keepScroll.current = false;
      return;
    }
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [detail?.messages.length, selected ? typingIn[selected] : undefined]);

  /** claim | hand-back | close */
  async function act(action: 'claim' | 'hand-back' | 'close') {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await apiFetch(`/conversations/${selected}/${action}`, { method: 'POST' });
    if (!res.ok) setError(await readError(res));
    await loadDetail(selected);
    setBusy(false);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!selected || !reply.trim()) return;
    notifier.current?.stop();
    setBusy(true);
    setError(null);
    const res = await apiFetch(`/conversations/${selected}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: reply }),
    });
    if (res.ok) {
      const message = (await res.json()) as AgentMessage;
      setReply('');
      setDetail((d) => (d ? { ...d, messages: mergeMessages(d.messages, [message]) } : d));
    } else setError(await readError(res));
    setBusy(false);
  }

  const conversation = detail?.conversation;
  const mineNow = conversation ? inboxTabFor(conversation, userId) === 'mine' : false;
  const takenByOther = conversation?.status === 'human' && !mineNow;
  const lastAgentMessage = detail?.messages.findLast((m) => m.sender === 'agent');
  const visitorSaw = (m: AgentMessage) =>
    m === lastAgentMessage &&
    Boolean(conversation?.visitorReadAt && conversation.visitorReadAt >= m.createdAt);
  const typingHere = selected ? typingIn[selected] : undefined;
  const onlineCount = team.filter((a) => a.state === 'online').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="mt-1 text-sm text-slate-500">
            Conversations from your website widget, updated live.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              {onlineCount} {onlineCount === 1 ? 'agent' : 'agents'} online
            </summary>
            <ul className="absolute right-0 z-10 mt-2 w-56 space-y-1 rounded-md border border-slate-200 bg-white p-3 text-sm shadow-lg">
              {team.map((a) => (
                <li key={a.userId} className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full', PRESENCE_DOT[a.state])} />
                  <span className="flex-1 truncate">
                    {a.name}
                    {a.userId === userId && ' (you)'}
                  </span>
                  <span className="text-xs text-slate-500">{PRESENCE_LABELS[a.state]}</span>
                </li>
              ))}
            </ul>
          </details>
          <span
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium',
              connected ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800',
            )}
          >
            {connected ? 'Live' : 'Connecting...'}
          </span>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      <div className="flex flex-wrap gap-1 border-b border-slate-200" role="tablist">
        {inboxTabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === t
                ? 'border-brand text-brand'
                : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {INBOX_TAB_LABELS[t]}
            <span
              className={cn(
                'ml-2 rounded-full px-2 py-0.5 text-xs',
                t === 'needs_agent' && (list?.counts[t] ?? 0) > 0
                  ? 'bg-rose-600 text-white'
                  : 'bg-slate-100 text-slate-600',
              )}
            >
              {list?.counts[t] ?? 0}
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card className="max-h-[70vh] overflow-y-auto p-0">
          {list && list.items.length === 0 && (
            <p className="p-6 text-sm text-slate-500">Nothing here right now.</p>
          )}
          <ul className="divide-y divide-slate-100">
            {list?.items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  className={cn(
                    'w-full px-4 py-3 text-left hover:bg-slate-50',
                    selected === c.id && 'bg-brand-soft',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'truncate text-sm',
                        c.unreadCount > 0 ? 'font-semibold' : 'font-medium',
                      )}
                    >
                      {c.visitorLabel}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-400">
                      {c.unreadCount > 0 && (
                        <span
                          className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
                          aria-label={`${c.unreadCount} unread`}
                        >
                          {c.unreadCount}
                        </span>
                      )}
                      {timeAgo(c.lastMessageAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {typingIn[c.id] ? (
                      <span className="text-brand italic">{typingIn[c.id]} is typing...</span>
                    ) : c.lastMessage ? (
                      c.lastMessage.content
                    ) : (
                      'No messages yet'
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                    <span className={cn('rounded-full px-2 py-0.5', STATUS_STYLE[c.status])}>
                      {STATUS_LABEL[c.status]}
                    </span>
                    {c.assignedAgentName && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                        {c.assignedAgentId === userId ? 'You' : c.assignedAgentName}
                      </span>
                    )}
                    {c.contactEmail && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">
                        Email left
                      </span>
                    )}
                    {c.lastConfidence !== null && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5',
                          confidenceStyle(c.lastConfidence),
                        )}
                      >
                        {Math.round(c.lastConfidence * 100)}%
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="flex min-h-[60vh] flex-col p-0">
          {!detail && <p className="m-auto p-6 text-sm text-slate-500">Select a conversation.</p>}
          {detail && conversation && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
                <div>
                  <p className="font-medium">{conversation.visitorLabel}</p>
                  <p className="text-xs text-slate-500">
                    {conversation.origin ?? 'unknown website'} · started{' '}
                    {timeAgo(conversation.createdAt)}
                  </p>
                  {conversation.status === 'waiting' && conversation.handoffReason && (
                    <p className="mt-1 text-xs font-medium text-rose-700">
                      {HANDOFF_REASON_LABELS[conversation.handoffReason as HandoffReason] ??
                        conversation.handoffReason}
                    </p>
                  )}
                  {conversation.contactEmail && (
                    <p className="mt-1 text-xs">
                      Follow up by email:{' '}
                      <a
                        className="text-brand underline"
                        href={`mailto:${conversation.contactEmail}`}
                      >
                        {conversation.contactEmail}
                      </a>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      STATUS_STYLE[conversation.status],
                    )}
                  >
                    {STATUS_LABEL[conversation.status]}
                    {conversation.assignedAgentName &&
                      ` · ${conversation.assignedAgentId === userId ? 'you' : conversation.assignedAgentName}`}
                  </span>
                  {conversation.status !== 'closed' && !mineNow && !takenByOther && (
                    <Button onClick={() => void act('claim')} disabled={busy}>
                      Take conversation
                    </Button>
                  )}
                  {(mineNow || conversation.status === 'waiting') && (
                    <Button variant="outline" onClick={() => void act('hand-back')} disabled={busy}>
                      Hand back to AI
                    </Button>
                  )}
                  {conversation.status !== 'closed' && !takenByOther && (
                    <Button variant="outline" onClick={() => void act('close')} disabled={busy}>
                      Close
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-5">
                {detail.hasMore && (
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => void loadEarlier()}
                      disabled={loadingMore}
                      className="text-xs text-brand underline"
                    >
                      {loadingMore ? 'Loading...' : 'Load earlier messages'}
                    </button>
                  </div>
                )}
                {detail.messages.map((m) => (
                  <MessageBubble key={m.id} message={m} seen={visitorSaw(m)} />
                ))}
                {typingHere && (
                  <p className="text-xs text-slate-500 italic" role="status">
                    {typingHere} is typing...
                  </p>
                )}
                <div ref={bottom} />
              </div>
              {conversation.status === 'closed' ? (
                <p className="border-t border-slate-200 p-4 text-sm text-slate-500">
                  This conversation is closed.
                </p>
              ) : takenByOther ? (
                <p className="border-t border-slate-200 p-4 text-sm text-slate-500">
                  {conversation.assignedAgentName} is handling this conversation.
                </p>
              ) : (
                <form onSubmit={send} className="flex gap-2 border-t border-slate-200 p-4">
                  <textarea
                    value={reply}
                    onChange={(e) => {
                      setReply(e.target.value);
                      if (e.target.value.trim()) notifier.current?.keystroke();
                      else notifier.current?.stop();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    rows={2}
                    maxLength={2000}
                    placeholder={
                      mineNow
                        ? 'Reply to the customer...'
                        : 'Replying takes the conversation (the AI stops answering)'
                    }
                    aria-label="Reply"
                    className="min-h-[44px] flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-brand/30"
                  />
                  <Button type="submit" disabled={busy || !reply.trim()}>
                    Send
                  </Button>
                </form>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
