'use client';

import { type ChatDone, type ChatSource, createChatStreamParser } from '@supportpilot/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { readError, useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface Turn {
  id: number;
  role: 'customer' | 'ai';
  text: string;
  done?: ChatDone;
  ms?: number;
}

const EXAMPLES = [
  'How long is the frame warranty?',
  'Can I return a bike?',
  'Do you sell skateboards?',
  'Can I talk to a real person?',
];

function confidenceStyle(value: number): string {
  if (value >= 0.7) return 'bg-emerald-100 text-emerald-800';
  if (value >= 0.4) return 'bg-amber-100 text-amber-800';
  return 'bg-rose-100 text-rose-800';
}

function Sources({ sources }: { sources: ChatSource[] }) {
  if (!sources.length) return null;
  return (
    <ul className="mt-2 space-y-1 border-t border-slate-200 pt-2">
      {sources.map((s) => (
        <li key={s.chunkId} className="text-xs text-slate-600">
          <span className="font-medium">[{s.ref}]</span> {s.documentTitle}
          {s.headingPath.length > 0 && ` > ${s.headingPath.join(' > ')}`}
          <span className="text-slate-400"> · similarity {s.similarity.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Test your assistant": the same RAG pipeline the widget uses, with sources and confidence. */
export default function PlaygroundPage() {
  const { apiFetch } = useAuth();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<string | undefined>(undefined);
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [turns]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setMessage('');
    const answerId = nextId.current + 1;
    nextId.current += 2;
    setTurns((t) => [
      ...t,
      { id: answerId - 1, role: 'customer', text: question },
      { id: answerId, role: 'ai', text: '' },
    ]);
    const update = (patch: Partial<Turn>) =>
      setTurns((t) => t.map((turn) => (turn.id === answerId ? { ...turn, ...patch } : turn)));
    const started = performance.now();
    let firstToken: number | undefined;
    try {
      const res = await apiFetch('/chat/playground', {
        method: 'POST',
        body: JSON.stringify({ message: question, conversationId: conversationId.current }),
      });
      if (!res.ok || !res.body) throw new Error(await readError(res));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createChatStreamParser();
      let answer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parse(decoder.decode(value, { stream: true }))) {
          if (event.event === 'meta') conversationId.current = event.data.conversationId;
          if (event.event === 'delta') {
            firstToken ??= Math.round(performance.now() - started);
            answer += event.data.text;
            update({ text: answer, ms: firstToken });
          }
          if (event.event === 'done') update({ text: event.data.content, done: event.data });
          if (event.event === 'error') throw new Error(event.data.message);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The assistant could not answer.');
      setTurns((t) => t.filter((turn) => turn.id !== answerId || turn.text));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(message);
  }

  function reset() {
    conversationId.current = undefined;
    setTurns([]);
    setError(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Test your assistant</h1>
          <p className="mt-1 text-sm text-slate-500">
            Ask what your customers would ask. Answers come only from your knowledge base, with
            sources and a confidence score. Low confidence means the chat would be handed to your
            team.
          </p>
        </div>
        <Button variant="outline" onClick={reset} disabled={busy || turns.length === 0}>
          New conversation
        </Button>
      </div>

      {error && <Alert>{error}</Alert>}

      <Card className="flex min-h-[420px] flex-col p-0">
        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {turns.length === 0 && (
            <div>
              <CardTitle>Try a question</CardTitle>
              <CardDescription>Or pick one of these:</CardDescription>
              <div className="mt-3 flex flex-wrap gap-2">
                {EXAMPLES.map((q) => (
                  <Button key={q} variant="outline" onClick={() => void send(q)}>
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={cn('flex', turn.role === 'customer' ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap',
                  turn.role === 'customer' ? 'bg-brand text-white' : 'bg-slate-100 text-slate-900',
                )}
              >
                {turn.text ||
                  (turn.role === 'ai' && <span className="text-slate-400">Thinking...</span>)}
                {turn.done && (
                  <>
                    <Sources sources={turn.done.sources} />
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 font-medium',
                          confidenceStyle(turn.done.confidence),
                        )}
                      >
                        Confidence {Math.round(turn.done.confidence * 100)}%
                      </span>
                      {turn.done.needsHuman && (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-800">
                          Would hand off to a person
                        </span>
                      )}
                      {turn.ms !== undefined && (
                        <span className="text-slate-400">first token {turn.ms} ms</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form onSubmit={onSubmit} className="flex gap-2 border-t border-slate-200 p-4">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Ask a question..."
            maxLength={2000}
            aria-label="Message"
          />
          <Button type="submit" disabled={busy || !message.trim()}>
            {busy ? 'Answering...' : 'Send'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
