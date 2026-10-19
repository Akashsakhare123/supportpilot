import type { INestApplication } from '@nestjs/common';
import { embedDocument, LocalHashEmbeddings } from '@supportpilot/ai';
import {
  and,
  createDb,
  createPool,
  documents,
  eq,
  messages,
  replaceDocumentChunks,
  tenants,
  usageEvents,
  type Database,
  type Pool,
} from '@supportpilot/db';
import type { ChatDone } from '@supportpilot/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, createTestTenant, TEST_PASSWORD, type TestTenant } from './helpers';

const SEED_DIR = path.resolve(__dirname, '../../../packages/db/seed-data/acme-bikes');

interface ParsedStream {
  status: number;
  events: { event: string; data: unknown }[];
  text: string;
  done: ChatDone;
}

/** Split an SSE body into events. */
function parseSse(body: string): { event: string; data: unknown }[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? 'null';
      return { event, data: JSON.parse(data) as unknown };
    });
}

describe('RAG chat API (T07)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: Database;
  let acme: TestTenant;
  let other: TestTenant;
  let acmeKey: string;
  let otherKey: string;
  const visitorId = 'visitor_test_123';
  const http = () => request(app.getHttpServer());

  async function ask(
    message: string,
    options: { key?: string; conversationId?: string; visitor?: string; origin?: string } = {},
  ): Promise<ParsedStream> {
    const res = await http()
      .post('/v1/chat')
      .set('Origin', options.origin ?? 'https://shop.example')
      .send({
        key: options.key ?? acmeKey,
        visitorId: options.visitor ?? visitorId,
        message,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      })
      .buffer(true)
      .parse((res, callback) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => callback(null, body));
      });
    const events = res.status === 200 ? parseSse(res.body as string) : [];
    const text = events
      .filter((e) => e.event === 'delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    const done = events.find((e) => e.event === 'done')?.data as ChatDone;
    return { status: res.status, events, text, done };
  }

  async function ingest(tenantId: string, file: string, title: string): Promise<void> {
    const [doc] = await db
      .insert(documents)
      .values({ tenantId, title, sourceType: 'text', source: file, status: 'processing' })
      .returning();
    const embedded = await embedDocument(
      title,
      readFileSync(path.join(SEED_DIR, file), 'utf8'),
      new LocalHashEmbeddings(),
    );
    await replaceDocumentChunks(db, {
      tenantId,
      documentId: doc!.id,
      embeddingModel: embedded.model,
      chunks: embedded.chunks,
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    acme = await createTestTenant('ChatAcme');
    other = await createTestTenant('ChatOther');
    await ingest(acme.tenantId, 'warranty.md', 'Warranty');
    await ingest(acme.tenantId, 'shipping-and-returns.md', 'Shipping and returns');
    const keyOf = async (id: string) =>
      (await db.query.tenants.findFirst({ where: eq(tenants.id, id) }))!.publicKey;
    acmeKey = await keyOf(acme.tenantId);
    otherKey = await keyOf(other.tenantId);
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('streams a grounded answer with a citation and high confidence', async () => {
    const started = Date.now();
    const res = await ask('How long is the frame warranty?');
    expect(res.status).toBe(200);
    expect(res.events[0]!.event).toBe('meta');
    expect(res.events.filter((e) => e.event === 'delta').length).toBeGreaterThan(3);
    expect(res.events.at(-1)!.event).toBe('done');
    expect(res.text).toMatch(/lifetime warranty/i);
    expect(res.text).not.toContain('@@META');
    expect(res.done.content).toBe(res.text.trim());
    expect(res.done.sources.length).toBeGreaterThan(0);
    expect(res.done.sources[0]!.documentTitle).toBe('Warranty');
    expect(res.done.confidence).toBeGreaterThanOrEqual(0.55);
    expect(res.done.needsHuman).toBe(false);
    expect(res.done.conversationStatus).toBe('ai');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('says it does not know, with low confidence, when the docs do not cover the question', async () => {
    const res = await ask('Do you sell skateboards?');
    expect(res.done.content).toMatch(/couldn't find that/);
    expect(res.done.sources).toEqual([]);
    expect(res.done.confidence).toBeLessThan(0.3);
    expect(res.done.needsHuman).toBe(true);
  });

  it('keeps one conversation across turns and stores every message with its sources', async () => {
    const first = await ask('Can I return a bike?', { visitor: 'visitor_memory_1' });
    const conversationId = first.done.conversationId;
    const second = await ask('How many days does shipping take?', {
      visitor: 'visitor_memory_1',
      conversationId,
    });
    expect(second.done.conversationId).toBe(conversationId);
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);
    expect(stored.map((m) => m.sender)).toEqual(['customer', 'ai', 'customer', 'ai']);
    expect(stored[1]!.sources.length).toBeGreaterThan(0);
    expect(stored[1]!.confidence).toBeGreaterThan(0);
    expect(stored[1]!.metadata).toMatchObject({ model: 'mock-extractive-v1' });
    const events = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.tenantId, acme.tenantId), eq(usageEvents.type, 'chat.answer')));
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('flags a request for a person without calling the model', async () => {
    const res = await ask('Can I talk to a real person?');
    expect(res.done.needsHuman).toBe(true);
    expect(res.done.content).toMatch(/connecting you|isn't online/);
    expect(res.done.conversationStatus).toBe('waiting');
  });

  it('masks personal data before it reaches the model, but keeps it for the agent', async () => {
    const res = await ask('My email is jane@example.com, where is my warranty claim?', {
      visitor: 'visitor_pii_1',
    });
    const [customer] = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.conversationId, res.done.conversationId), eq(messages.sender, 'customer')),
      );
    expect(customer!.content).toContain('jane@example.com');
    expect(customer!.metadata).toMatchObject({ piiMasked: ['email'] });
  });

  it("never answers from another tenant's documents", async () => {
    // The other tenant has no documents at all.
    const res = await ask('How long is the frame warranty?', { key: otherKey });
    expect(res.done.sources).toEqual([]);
    expect(res.done.content).toMatch(/couldn't find that/);
  });

  it("refuses another tenant's or another visitor's conversation", async () => {
    const mine = await ask('Hi there, do you ship abroad?', { visitor: 'visitor_owner_1' });
    const stolen = await ask('Hi', { key: otherKey, conversationId: mine.done.conversationId });
    expect(stolen.status).toBe(404);
    const otherVisitor = await ask('Hi', {
      visitor: 'visitor_thief_1',
      conversationId: mine.done.conversationId,
    });
    expect(otherVisitor.status).toBe(404);
  });

  it('rejects bad input before streaming: unknown key, bad body, blocked website', async () => {
    expect((await ask('Hi', { key: 'pk_test_does_not_exist' })).status).toBe(404);
    const bad = await http().post('/v1/chat').send({ key: acmeKey, visitorId, message: '' });
    expect(bad.status).toBe(400);
    await db
      .update(tenants)
      .set({ allowedDomains: ['acme.example'] })
      .where(eq(tenants.id, acme.tenantId));
    try {
      expect((await ask('Hi', { origin: 'https://evil.example' })).status).toBe(403);
      expect(
        (await ask('How long is the frame warranty?', { origin: 'https://shop.acme.example' }))
          .status,
      ).toBe(200);
    } finally {
      await db.update(tenants).set({ allowedDomains: [] }).where(eq(tenants.id, acme.tenantId));
    }
  });

  it('lets signed-in team members test the assistant in the dashboard playground', async () => {
    const login = await http()
      .post('/auth/login')
      .send({ email: acme.agent.email, password: TEST_PASSWORD })
      .expect(200);
    const res = await http()
      .post('/chat/playground')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`)
      .send({ message: 'How long is the frame warranty?' })
      .buffer(true)
      .parse((r, callback) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (body += chunk));
        r.on('end', () => callback(null, body));
      });
    expect(res.status).toBe(200);
    const done = parseSse(res.body as string).find((e) => e.event === 'done')!.data as ChatDone;
    expect(done.sources[0]!.documentTitle).toBe('Warranty');

    await http().post('/chat/playground').send({ message: 'Hi' }).expect(401);
  });
});
