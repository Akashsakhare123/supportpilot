import { describe, expect, it, vi } from 'vitest';
import { createLlmProvider, MockLlmProvider, OpenAiChatProvider } from './llm';
import { AnswerStreamSplitter, buildRagMessages } from './prompt';

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

async function answer(question: string, passages: string[]) {
  const messages = buildRagMessages({
    tenantName: 'Acme',
    question,
    passages: passages.map((content, i) => ({
      ref: i + 1,
      title: `Doc ${i + 1}`,
      headingPath: [],
      content,
    })),
    history: [],
  });
  const splitter = new AnswerStreamSplitter();
  let text = '';
  for (const chunk of await collect(new MockLlmProvider().stream(messages)))
    text += splitter.push(chunk);
  const end = splitter.finish();
  return { text: (text + end.rest).trim(), meta: end.meta };
}

describe('MockLlmProvider', () => {
  it('keeps a sentence that is wrapped over two lines together', async () => {
    const result = await answer('When do weekend orders ship?', [
      'You get a tracking link by email. Orders placed on a\nweekend are dispatched on Monday.\n\n- Next line is separate.',
    ]);
    expect(result.text).toBe('Orders placed on a weekend are dispatched on Monday [1].');
  });

  it('answers from the matching passage and cites it', async () => {
    const result = await answer('How long is the frame warranty?', [
      'Orders ship in 3-5 business days.',
      '- **Frames**: lifetime warranty against manufacturing defects.',
    ]);
    expect(result.text).toBe('Frames: lifetime warranty against manufacturing defects [2].');
    expect(result.meta).toMatchObject({ answered: true, sources: [2] });
    expect(result.meta!.confidence).toBeGreaterThan(0.5);
  });

  it('says it does not know when the passages do not cover the question', async () => {
    const result = await answer('Do you sell skateboards?', [
      'If your frame is damaged in a crash, we sell you a replacement frame at 40% off.',
    ]);
    expect(result.text).toMatch(/couldn't find that/);
    expect(result.meta).toEqual({ answered: false, confidence: 0, sources: [] });
  });

  it('uses the document title as context, but the sentence must be on topic', async () => {
    const messages = buildRagMessages({
      tenantName: 'Acme',
      question: 'What skills does Akash have?',
      passages: [
        {
          ref: 1,
          title: 'Akash Sakhare Resume',
          headingPath: [],
          content: 'Akash Sakhare\nPune, India\nSkills: TypeScript, NestJS, React, PostgreSQL',
        },
      ],
      history: [],
    });
    const splitter = new AnswerStreamSplitter();
    let text = '';
    for (const chunk of await collect(new MockLlmProvider().stream(messages)))
      text += splitter.push(chunk);
    expect(text).toContain('Skills: TypeScript, NestJS, React, PostgreSQL [1].');
    expect(splitter.finish().meta).toMatchObject({ answered: true, sources: [1] });
  });

  it('streams in several chunks', async () => {
    const messages = buildRagMessages({
      tenantName: 'A',
      question: 'x',
      passages: [],
      history: [],
    });
    expect((await collect(new MockLlmProvider().stream(messages))).length).toBeGreaterThan(5);
  });
});

describe('OpenAiChatProvider', () => {
  const sse = (lines: string[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Split mid-line to exercise buffering.
          const body = lines.join('\n');
          controller.enqueue(encoder.encode(body.slice(0, 25)));
          controller.enqueue(encoder.encode(body.slice(25)));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

  it('parses a streamed completion', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      sse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        ': keep-alive',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: [DONE]',
        '',
      ]),
    );
    const provider = new OpenAiChatProvider({ apiKey: 'sk-x', fetchImpl, model: 'gpt-test' });
    expect((await collect(provider.stream([{ role: 'user', content: 'hi' }]))).join('')).toBe(
      'Hello',
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'gpt-test', stream: true });
  });

  it('retries 429 before streaming and fails on 401', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const flaky = vi.fn(async () =>
        ++calls === 1
          ? new Response('slow', { status: 429 })
          : sse(['data: {"choices":[{"delta":{"content":"ok"}}]}', '']),
      );
      const pending = collect(new OpenAiChatProvider({ apiKey: 'k', fetchImpl: flaky }).stream([]));
      await vi.runAllTimersAsync();
      expect((await pending).join('')).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
    const denied = vi.fn(async () => new Response('bad key', { status: 401 }));
    await expect(
      collect(new OpenAiChatProvider({ apiKey: 'k', fetchImpl: denied }).stream([])),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('createLlmProvider', () => {
  it('defaults to the offline mock and validates the OpenAI settings', () => {
    expect(createLlmProvider({}).model).toBe('mock-extractive-v1');
    expect(() => createLlmProvider({ LLM_PROVIDER: 'openai' })).toThrow(/API_KEY/);
    expect(
      createLlmProvider({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk', LLM_MODEL: 'gpt-4.1-mini' })
        .model,
    ).toBe('gpt-4.1-mini');
    // Local OpenAI-compatible server (Ollama) needs no key.
    expect(
      createLlmProvider({
        LLM_PROVIDER: 'openai',
        OPENAI_BASE_URL: 'http://localhost:11434',
        LLM_MODEL: 'llama3.2',
      }).model,
    ).toBe('llama3.2');
    expect(() => createLlmProvider({ LLM_PROVIDER: 'nope' })).toThrow(/Unknown/);
  });
});
