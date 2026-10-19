import type { INestApplication } from '@nestjs/common';
import { embedDocument, LocalHashEmbeddings } from '@supportpilot/ai';
import {
  createDb,
  createPool,
  documents,
  eq,
  replaceDocumentChunks,
  tenants,
  type Database,
  type Pool,
} from '@supportpilot/db';
import type {
  AgentServerEvents,
  ChatDone,
  ConversationDetail,
  ConversationSummary,
  InboxList,
  WidgetClientEvents,
  WidgetServerEvents,
} from '@supportpilot/shared';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, createTestTenant, TEST_PASSWORD, type TestTenant } from './helpers';

type WidgetSocket = Socket<WidgetServerEvents, WidgetClientEvents>;
type AgentSocket = Socket<AgentServerEvents>;
const SEED_DIR = path.resolve(__dirname, '../../../packages/db/seed-data/acme-bikes');

/** Resolve on the first event matching the predicate (or fail after a timeout). */
interface Listenable {
  on(event: string, listener: (payload: never) => void): unknown;
  off(event: string, listener: (payload: never) => void): unknown;
}

function nextEvent<T>(
  target: unknown,
  event: string,
  match: (payload: T) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<T> {
  const socket = target as Listenable;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

describe('Agent inbox (T09)', () => {
  // Two API instances sharing Postgres and Redis, like two containers behind a load balancer.
  let appA: INestApplication;
  let appB: INestApplication;
  let urlA: string;
  let urlB: string;
  let pool: Pool;
  let db: Database;
  let acme: TestTenant;
  let other: TestTenant;
  let key: string;
  const tokens: Record<string, string> = {};
  const sockets: { disconnect(): unknown }[] = [];

  async function login(app: INestApplication, email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  const api = (token: string) => ({
    get: (url: string) =>
      request(appA.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) =>
      request(appA.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
  });

  function widget(url: string, visitorId: string): WidgetSocket {
    const s: WidgetSocket = io(`${url}/widget`, {
      auth: { key, visitorId },
      extraHeaders: { origin: 'https://shop.example' },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    return s;
  }

  function agent(url: string, token: string | undefined): AgentSocket {
    const s: AgentSocket = io(`${url}/agent`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    return s;
  }

  const connected = (target: WidgetSocket | AgentSocket) =>
    new Promise<void>((resolve, reject) => {
      const s = target as unknown as Socket;
      if (s.connected) return resolve();
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });

  async function ask(s: WidgetSocket, message: string, conversationId?: string) {
    const done = nextEvent<ChatDone>(s, 'message:done');
    const ack = await s.emitWithAck('message:send', { message, conversationId });
    if (!ack.ok) throw new Error(ack.message);
    return done;
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await appA.listen(0);
    await appB.listen(0);
    urlA = `http://127.0.0.1:${(appA.getHttpServer().address() as AddressInfo).port}`;
    urlB = `http://127.0.0.1:${(appB.getHttpServer().address() as AddressInfo).port}`;
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    acme = await createTestTenant('InboxAcme');
    other = await createTestTenant('InboxOther');
    const [doc] = await db
      .insert(documents)
      .values({ tenantId: acme.tenantId, title: 'Warranty', sourceType: 'text', source: 'w.md' })
      .returning();
    const embedded = await embedDocument(
      'Warranty',
      readFileSync(path.join(SEED_DIR, 'warranty.md'), 'utf8'),
      new LocalHashEmbeddings(),
    );
    await replaceDocumentChunks(db, {
      tenantId: acme.tenantId,
      documentId: doc!.id,
      embeddingModel: embedded.model,
      chunks: embedded.chunks,
    });
    key = (await db.query.tenants.findFirst({ where: eq(tenants.id, acme.tenantId) }))!.publicKey;
    tokens.agent = await login(appA, acme.agent.email);
    tokens.admin = await login(appA, acme.admin.email);
    tokens.other = await login(appA, other.admin.email);
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await pool?.end();
    await appA?.close();
    await appB?.close();
  });

  it('shows a new low-confidence widget conversation in "Needs agent" live, across instances', async () => {
    // The agent's dashboard is connected to instance A, the visitor's widget to instance B.
    const dashboard = agent(urlA, tokens.agent);
    await connected(dashboard);
    const visitor = widget(urlB, 'visitor_inbox_1');
    await connected(visitor);

    const upsert = nextEvent<ConversationSummary>(
      dashboard,
      'conversation:upsert',
      (s) => s.lowConfidenceStreak > 0,
    );
    const done = await ask(visitor, 'Do you sell skateboards?');
    expect(done.needsHuman).toBe(true);
    const summary = await upsert;
    expect(summary.id).toBe(done.conversationId);
    expect(summary.lastMessage?.sender).toBe('ai');

    const list = await api(tokens.agent).get('/conversations?tab=needs_agent').expect(200);
    const body = list.body as InboxList;
    expect(body.items.map((c) => c.id)).toContain(done.conversationId);
    expect(body.counts.needs_agent).toBeGreaterThanOrEqual(1);

    const detail = (
      await api(tokens.agent).get(`/conversations/${done.conversationId}`).expect(200)
    ).body as ConversationDetail;
    expect(detail.messages.map((m) => m.sender)).toEqual(['customer', 'ai']);
    expect(detail.messages[1]).toMatchObject({ needsHuman: true, confidence: 0 });
  });

  it('claiming is exclusive and the AI stops answering', async () => {
    const visitor = widget(urlA, 'visitor_inbox_2');
    await connected(visitor);
    const first = await ask(visitor, 'How long is the frame warranty?');
    const id = first.conversationId;

    const [a, b] = await Promise.all([
      api(tokens.agent).post(`/conversations/${id}/claim`),
      api(tokens.admin).post(`/conversations/${id}/claim`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? tokens.agent : tokens.admin;
    const loser = a.status === 200 ? tokens.admin : tokens.agent;
    expect((a.status === 409 ? a : b).body.message).toMatch(/Already taken by/);

    // The loser cannot reply either; the winner can.
    await api(loser).post(`/conversations/${id}/messages`, { message: 'Hi!' }).expect(409);

    // While a person handles it, the customer's next message gets no AI answer.
    const second = await ask(visitor, 'And the battery warranty?', id);
    expect(second).toMatchObject({ messageId: null, content: '', conversationStatus: 'human' });

    const detail = (await api(winner).get(`/conversations/${id}`).expect(200))
      .body as ConversationDetail;
    expect(detail.conversation.status).toBe('human');
    expect(detail.messages.map((m) => m.sender)).toEqual(['customer', 'ai', 'system', 'customer']);
  });

  it("pushes an agent reply to the visitor's widget instantly, even on another instance", async () => {
    const visitor = widget(urlB, 'visitor_inbox_3');
    await connected(visitor);
    const first = await ask(visitor, 'How long is the frame warranty?');
    const id = first.conversationId;

    const status = nextEvent<{ status: string; agentName: string | null }>(
      visitor,
      'conversation:status',
    );
    const reply = nextEvent<{
      conversationId: string;
      message: { sender: string; content: string };
    }>(visitor, 'message:new');
    // Replying to an unassigned conversation claims it first.
    const res = await api(tokens.agent)
      .post(`/conversations/${id}/messages`, { message: 'Hi, I am here to help!' })
      .expect(201);
    expect(res.body).toMatchObject({ sender: 'agent', content: 'Hi, I am here to help!' });
    expect((await status).status).toBe('human');
    expect(await reply).toMatchObject({
      conversationId: id,
      message: { sender: 'agent', content: 'Hi, I am here to help!' },
    });

    // The widget's history after a reload includes the agent reply (system notes are hidden).
    const history = await visitor.emitWithAck('conversation:history', { conversationId: id });
    expect(history.ok && history.messages.map((m) => m.sender)).toEqual([
      'customer',
      'ai',
      'agent',
    ]);
  });

  it('keeps tenants apart: lists, details, claims and live events', async () => {
    const otherDashboard = agent(urlA, tokens.other);
    await connected(otherDashboard);
    let leaked = false;
    otherDashboard.on('conversation:upsert', () => {
      leaked = true;
    });
    const visitor = widget(urlA, 'visitor_inbox_4');
    await connected(visitor);
    const done = await ask(visitor, 'Do you sell skateboards?');

    const list = (await api(tokens.other).get('/conversations?tab=needs_agent').expect(200))
      .body as InboxList;
    expect(list.items.map((c) => c.id)).not.toContain(done.conversationId);
    await api(tokens.other).get(`/conversations/${done.conversationId}`).expect(404);
    await api(tokens.other).post(`/conversations/${done.conversationId}/claim`).expect(404);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(leaked).toBe(false);
  });

  it('refuses dashboard sockets without a valid token and validates input', async () => {
    const error = await new Promise<Error>((resolve) => {
      agent(urlA, 'not-a-token').once('connect_error', resolve);
    });
    expect(error.message).toMatch(/Invalid or expired/);
    await api(tokens.agent).get('/conversations?tab=everything').expect(400);
    await request(appA.getHttpServer()).get('/conversations').expect(401);
  });
});
