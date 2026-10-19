import type { INestApplication } from '@nestjs/common';
import { embedDocument, LocalHashEmbeddings } from '@supportpilot/ai';
import {
  conversations,
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
  ChatDone,
  ConversationDetail,
  ConversationSummary,
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
type StatusEvent = Parameters<WidgetServerEvents['conversation:status']>[0];
const SEED_DIR = path.resolve(__dirname, '../../../packages/db/seed-data/acme-bikes');

describe('Handoff logic (T10)', () => {
  let app: INestApplication;
  let url: string;
  let pool: Pool;
  let db: Database;
  let acme: TestTenant;
  let key: string;
  let agentToken: string;
  let adminToken: string;
  const open: { disconnect(): unknown }[] = [];

  const api = (token: string) => ({
    get: (u: string) => request(app.getHttpServer()).get(u).set('Authorization', `Bearer ${token}`),
    post: (u: string, body?: object) =>
      request(app.getHttpServer())
        .post(u)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
    patch: (u: string, body: object) =>
      request(app.getHttpServer()).patch(u).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function widget(visitorId: string): Promise<WidgetSocket> {
    const s: WidgetSocket = io(`${url}/widget`, {
      auth: { key, visitorId },
      extraHeaders: { origin: 'https://shop.example' },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    open.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return s;
  }

  async function dashboard(token: string): Promise<void> {
    const s = io(`${url}/agent`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    open.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
  }

  async function ask(s: WidgetSocket, message: string, conversationId?: string): Promise<ChatDone> {
    const done = new Promise<ChatDone>((resolve) => s.once('message:done', resolve));
    const ack = await s.emitWithAck('message:send', { message, conversationId });
    if (!ack.ok) throw new Error(ack.message);
    return done;
  }

  function statusEvent(s: WidgetSocket): Promise<StatusEvent> {
    return new Promise((resolve) => s.once('conversation:status', resolve));
  }

  async function statusOf(id: string) {
    return (await db.query.conversations.findFirst({ where: eq(conversations.id, id) }))!;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    acme = await createTestTenant('HandoffAcme');
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
    const login = async (email: string) =>
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: TEST_PASSWORD })
          .expect(200)
      ).body.accessToken as string;
    agentToken = await login(acme.agent.email);
    adminToken = await login(acme.admin.email);
  });

  afterEach(() => {
    for (const s of open.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('one low-confidence answer flags the chat; the second in a row hands it to a person', async () => {
    const s = await widget('visitor_handoff_1');
    const first = await ask(s, 'Do you sell skateboards?');
    expect(first).toMatchObject({ needsHuman: true, conversationStatus: 'ai' });
    const waiting = statusEvent(s);
    const second = await ask(s, 'What about scooters?', first.conversationId);
    expect(second.conversationStatus).toBe('waiting');
    expect(await waiting).toMatchObject({ status: 'waiting', agentsOnline: false });
    const row = await statusOf(first.conversationId);
    expect(row).toMatchObject({ status: 'waiting', handoffReason: 'low_confidence' });

    // While waiting, the AI stays out of the conversation.
    const third = await ask(s, 'Hello?', first.conversationId);
    expect(third).toMatchObject({ messageId: null, content: '' });
  });

  it('a confident answer resets the low-confidence streak', async () => {
    const s = await widget('visitor_handoff_2');
    const first = await ask(s, 'Do you sell skateboards?');
    await ask(s, 'How long is the frame warranty?', first.conversationId);
    const third = await ask(s, 'Do you sell scooters?', first.conversationId);
    expect(third.conversationStatus).toBe('ai');
  });

  it('"talk to a person" with no agent online: offline reply, then the customer leaves an email', async () => {
    const s = await widget('visitor_handoff_3');
    const done = await ask(s, 'Can I talk to a real person?');
    expect(done.content).toMatch(/isn't online/);
    expect(done.conversationStatus).toBe('waiting');

    const bad = await s.emitWithAck('ticket:email', {
      conversationId: done.conversationId,
      email: 'not-an-email',
    });
    expect(bad).toMatchObject({ ok: false, code: 'invalid' });
    const ok = await s.emitWithAck('ticket:email', {
      conversationId: done.conversationId,
      email: 'Jane@Example.com',
    });
    expect(ok).toEqual({ ok: true });

    const summary = (await api(agentToken).get(`/conversations/${done.conversationId}`).expect(200))
      .body as ConversationDetail;
    expect(summary.conversation).toMatchObject({
      status: 'waiting',
      contactEmail: 'jane@example.com',
      handoffReason: 'customer_request',
    });

    // Someone else's conversation id is refused.
    const stranger = await widget('visitor_handoff_9');
    expect(
      await stranger.emitWithAck('ticket:email', {
        conversationId: done.conversationId,
        email: 'evil@example.com',
      }),
    ).toMatchObject({ ok: false, code: 'conversation_not_found' });
  });

  it('"talk to a person" with an agent online: connecting reply', async () => {
    await dashboard(agentToken);
    const s = await widget('visitor_handoff_4');
    const status = statusEvent(s);
    const done = await ask(s, 'Can I speak to an agent?');
    expect(done.content).toMatch(/connecting you/);
    expect(await status).toMatchObject({ status: 'waiting', agentsOnline: true });
  });

  it('hand back to AI resumes AI answers; close ends it and the next question starts fresh', async () => {
    const s = await widget('visitor_handoff_5');
    const first = await ask(s, 'How long is the frame warranty?');
    const id = first.conversationId;
    await api(agentToken).post(`/conversations/${id}/claim`).expect(200);

    // Only the assigned agent may hand back or close.
    await api(adminToken).post(`/conversations/${id}/hand-back`).expect(409);
    await api(adminToken).post(`/conversations/${id}/close`).expect(409);

    const handedBack = statusEvent(s);
    const back = await api(agentToken).post(`/conversations/${id}/hand-back`).expect(200);
    expect((back.body as ConversationSummary).status).toBe('ai');
    expect((await handedBack).status).toBe('ai');
    const again = await ask(s, 'How long is the frame warranty?', id);
    expect(again.content).toMatch(/lifetime warranty/i);
    expect(again.messageId).not.toBeNull();

    const closed = statusEvent(s);
    await api(agentToken).post(`/conversations/${id}/close`).expect(200);
    expect((await closed).status).toBe('closed');
    // Invalid transitions are refused.
    await api(agentToken).post(`/conversations/${id}/close`).expect(409);
    await api(agentToken).post(`/conversations/${id}/hand-back`).expect(409);
    await api(agentToken).post(`/conversations/${id}/claim`).expect(409);
    await api(agentToken).post(`/conversations/${id}/messages`, { message: 'hi' }).expect(409);

    const fresh = await ask(s, 'Can I return a bike?', id);
    expect(fresh.conversationId).not.toBe(id);
  });

  it('the per-tenant threshold decides what counts as low confidence', async () => {
    await api(adminToken).patch('/tenant', { handoffThreshold: 0.9 }).expect(200);
    await api(adminToken).patch('/tenant', { handoffThreshold: 0.95 }).expect(400);
    await api(agentToken).patch('/tenant', { handoffThreshold: 0.5 }).expect(403);
    try {
      const s = await widget('visitor_handoff_6');
      const done = await ask(s, 'How long is the frame warranty?');
      expect(done.confidence).toBeLessThan(0.9);
      expect(done.needsHuman).toBe(true);
    } finally {
      await api(adminToken).patch('/tenant', { handoffThreshold: 0.55 }).expect(200);
    }
  });
});
