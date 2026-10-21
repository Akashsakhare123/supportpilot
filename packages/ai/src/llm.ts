import { keywords } from './embeddings';
import { META_MARKER, type LlmMessage } from './prompt';

export interface LlmStreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

/** A chat model that streams its answer as text chunks. */
export interface LlmProvider {
  readonly model: string;
  stream(messages: LlmMessage[], options?: LlmStreamOptions): AsyncIterable<string>;
}

export interface OpenAiChatOptions {
  apiKey?: string;
  model?: string;
  /** Any OpenAI-compatible server: OpenAI, Groq, Together, or a local Ollama (http://localhost:11434). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

/** OpenAI-compatible /v1/chat/completions with streaming, retrying 429 / 5xx before the first token. */
export class OpenAiChatProvider implements LlmProvider {
  readonly model: string;

  constructor(private readonly options: OpenAiChatOptions) {
    this.model = options.model ?? 'gpt-4o-mini';
  }

  async *stream(messages: LlmMessage[], options: LlmStreamOptions = {}): AsyncIterable<string> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = (this.options.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(`${base}/v1/chat/completions`, {
        method: 'POST',
        signal: options.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 500,
        }),
      });
      if (res.ok) break;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= (this.options.maxRetries ?? 2)) {
        throw new Error(
          `LLM request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
    }
    if (!res.body) throw new Error('LLM response has no body');

    const decoder = new TextDecoder();
    let pending = '';
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const data = line.trim();
          if (!data.startsWith('data:')) continue;
          const payload = data.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const text = json.choices?.[0]?.delta?.content;
            if (text) yield text;
          } catch {
            // Ignore keep-alive comments and partial lines.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function lastUserMessage(messages: LlmMessage[]): string {
  return [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
}

/**
 * Offline, free stand-in for a real model (LLM_PROVIDER=mock, the default). It is extractive:
 * it picks the context sentences that share the most keywords with the question and cites them,
 * or says it does not know. Deterministic, so tests and CI can check answers exactly. It reads
 * the same prompt a real model gets, so the whole pipeline runs unchanged.
 */
export class MockLlmProvider implements LlmProvider {
  readonly model = 'mock-extractive-v1';

  async *stream(messages: LlmMessage[]): AsyncIterable<string> {
    const prompt = lastUserMessage(messages);
    const question = /<question>\n?([\s\S]*?)\n?<\/question>/.exec(prompt)?.[1] ?? prompt;
    const wanted = new Set(keywords(question));
    const candidates: {
      ref: number;
      sentence: string;
      score: number;
      hits: number;
      own: number;
    }[] = [];
    const passages = /<passage id="(\d+)"(?: source="([^"]*)")?[^>]*>\n?([\s\S]*?)\n?<\/passage>/g;
    for (const match of prompt.matchAll(passages)) {
      const ref = Number(match[1]);
      // Words of the document title / headings count too ("Akash Sakhare Resume" > "skills").
      const context = new Set(keywords(match[2] ?? ''));
      const sentences = match[3]!
        .replace(/\*\*|__|`/g, '')
        // Soft-wrapped lines belong to one sentence; blank lines, bullets, tables, headings and
        // numbered steps still start a new one (found by the eval set, T14).
        .replace(/\n(?!\s*(?:\n|[-*|#]|\d+\.))/g, ' ')
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
        // Drop table separators, FAQ questions and very short fragments.
        .filter(
          (s) =>
            s.length > 15 &&
            !s.endsWith('?') && // FAQ questions are not answers
            !/^[|:\s-]+$/.test(s) &&
            !(s.startsWith('|') && !/\d/.test(s)),
        );
      for (const sentence of sentences) {
        const words = new Set(keywords(sentence));
        const own = [...wanted].filter((w) => words.has(w)).length;
        if (own === 0) continue; // the sentence itself must be on topic
        const hits = [...wanted].filter((w) => words.has(w) || context.has(w)).length;
        candidates.push({ ref, sentence, hits, own, score: hits / wanted.size });
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.own - a.own);
    const best = candidates[0];
    const enough = best && best.score >= 0.5 && (wanted.size < 2 || best.hits >= 2);
    let answer: string;
    let meta: { answered: boolean; confidence: number; sources: number[] };
    if (enough) {
      const picked = candidates.filter((c) => c.score >= best.score * 0.75).slice(0, 2);
      answer = picked.map((c) => `${c.sentence.replace(/[.!?:;,]+$/, '')} [${c.ref}].`).join(' ');
      meta = {
        answered: true,
        confidence: Math.round(Math.min(1, best.score) * 100) / 100,
        sources: [...new Set(picked.map((c) => c.ref))],
      };
    } else {
      answer =
        "I'm sorry, I couldn't find that in our help articles. Would you like me to connect you with a person from our team?";
      meta = { answered: false, confidence: 0, sources: [] };
    }
    // Stream word by word, like a real model.
    for (const piece of answer.match(/\S+\s*/g) ?? []) yield piece;
    yield `\n${META_MARKER} ${JSON.stringify(meta)}`;
  }
}

/**
 * Pick the chat model from env: LLM_PROVIDER=mock (default, offline) or openai (needs
 * LLM_API_KEY / OPENAI_API_KEY unless OPENAI_BASE_URL points to a local server such as Ollama).
 */
export function createLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const provider = (env.LLM_PROVIDER || 'mock').toLowerCase();
  if (provider === 'mock' || provider === 'local') return new MockLlmProvider();
  if (provider === 'openai') {
    const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY || undefined;
    if (!apiKey && !env.OPENAI_BASE_URL) {
      throw new Error(
        'LLM_PROVIDER=openai needs LLM_API_KEY or OPENAI_API_KEY (or OPENAI_BASE_URL for a local server)',
      );
    }
    return new OpenAiChatProvider({
      apiKey,
      model: env.LLM_MODEL || undefined,
      baseUrl: env.OPENAI_BASE_URL || undefined,
    });
  }
  throw new Error(`Unknown LLM_PROVIDER "${provider}" (use mock or openai)`);
}
