import type { INestApplication } from '@nestjs/common';
import {
  conversations,
  createDb,
  createPool,
  type Database,
  documents,
  eq,
  messages,
  type Pool,
  tenants,
} from '@supportpilot/db';
import type {
  AnalyticsOverview,
  ChatDone,
  WidgetClientEvents,
  WidgetServerEvents,
} from '@supportpilot/shared';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createTestApp, createTestTenant, TEST_PASSWORD, type TestTenant } from './helpers';

type WidgetSocket = Socket<WidgetServerEvents, WidgetClientEvents>;
type Row = typeof messages.$inferInsert;

describe('Analytics (T12)', () => {
  let app: INestApplication;
  let url: string;
  let pool: Pool;
  let db: Database;
  let acme: TestTenant;
  let other: TestTenant;
  let acmeAdmin: string;
  let acmeAgent: string;
  let otherAdmin: string;
  let resolvedId: string;
  let handedOffId: string;
  const open: WidgetSocket[] = [];
  /** A fixed moment yesterday, so every row falls inside the default 30-day range. */
  const base = Date.now() - 24 * 3_600_000;
  const at = (seconds: number) => new Date(base + seconds * 1000);

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
  const overview = async (token: string, query = 'tz=UTC') =>
    (await get(`/analytics?${query}`, token).expect(200)).body as AnalyticsOverview;

  /** A conversation with messages at fixed offsets (seconds from `base`). */
  async function conversation(
    tenantId: string,
    visitorId: string,
    rows: Omit<Row, 'conversationId' | 'tenantId'>[],
    extra: Partial<typeof conversations.$inferInsert> = {},
  ): Promise<string> {
    const [c] = await db
      .insert(conversations)
      .values({ tenantId, visitorId, status: 'closed', createdAt: rows[0]!.createdAt, ...extra })
      .returning({ id: conversations.id });
    await db.insert(messages).values(rows.map((r) => ({ ...r, conversationId: c!.id, tenantId })));
    return c!.id;
  }

  async function widget(key: string, visitorId: string): Promise<WidgetSocket> {
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

  const keyOf = async (tenantId: string) =>
    (await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }))!.publicKey;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    acme = await createTestTenant('AnalyticsAcme');
    other = await createTestTenant('AnalyticsOther');
    const login = async (email: string) =>
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: TEST_PASSWORD })
          .expect(200)
      ).body.accessToken as string;
    acmeAdmin = await login(acme.admin.email);
    acmeAgent = await login(acme.agent.email);
    otherAdmin = await login(other.admin.email);

    // 1. Answered by the AI alone (2 s first response), rated helpful.
    resolvedId = await conversation(acme.tenantId, 'v_resolved_1', [
      { sender: 'customer', content: 'How long is the frame warranty?', createdAt: at(0) },
      {
        sender: 'ai',
        content: 'Frames have a lifetime warranty.',
        confidence: 0.8,
        feedback: 'up',
        createdAt: at(2),
      },
    ]);
    // 2. Two questions the AI could not answer, then a hand-off; an agent replies 60 s later.
    handedOffId = await conversation(
      acme.tenantId,
      'v_handoff_1',
      [
        { sender: 'customer', content: 'Do you sell skateboards?', createdAt: at(100) },
        {
          sender: 'ai',
          content: 'Not found',
          confidence: 0,
          needsHuman: true,
          metadata: { reason: 'no_relevant_passages' },
          createdAt: at(101),
        },
        { sender: 'customer', content: 'Do you have skateboards?', createdAt: at(130) },
        {
          sender: 'ai',
          content: 'Not found',
          confidence: 0,
          needsHuman: true,
          metadata: { reason: 'no_relevant_passages' },
          createdAt: at(131),
        },
        { sender: 'system', content: 'Waiting for an agent.', createdAt: at(132) },
        {
          sender: 'agent',
          userId: acme.agent.id,
          content: 'Hi! No skateboards.',
          createdAt: at(192),
        },
      ],
      { firstHandoffAt: at(132), handoffReason: 'low_confidence' },
    );
    // 3. Answered, but the customer said it was not helpful; plus a formula in the question.
    await conversation(acme.tenantId, 'v_down_1', [
      {
        sender: 'customer',
        content: '=HYPERLINK("http://evil.example","x") refund?',
        createdAt: at(300),
      },
      {
        sender: 'ai',
        content: 'Refunds take 5-7 days.',
        confidence: 0.7,
        feedback: 'down',
        createdAt: at(301),
      },
    ]);
    // 4. "Talk to a person" is a request, not a knowledge gap (not in the question reports).
    await conversation(acme.tenantId, 'v_human_1', [
      { sender: 'customer', content: 'Can I talk to a real person?', createdAt: at(400) },
      {
        sender: 'ai',
        content: 'Connecting you.',
        confidence: 0,
        needsHuman: true,
        createdAt: at(401),
      },
    ]);
    // 5. Dashboard playground chats never count.
    await conversation(acme.tenantId, `playground:${acme.admin.id}`, [
      { sender: 'customer', content: 'Do you sell skateboards?', createdAt: at(500) },
      { sender: 'ai', content: 'Not found', confidence: 0, needsHuman: true, createdAt: at(501) },
    ]);
    // The other tenant asks the same question five times: must never show up for Acme.
    for (let i = 0; i < 5; i++) {
      await conversation(other.tenantId, `v_other_${i}`, [
        { sender: 'customer', content: 'Do you sell skateboards?', createdAt: at(600 + i) },
        {
          sender: 'ai',
          content: 'Not found',
          confidence: 0,
          needsHuman: true,
          createdAt: at(601 + i),
        },
      ]);
    }
  });

  afterEach(() => {
    for (const s of open.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('needs a login and the admin role', async () => {
    await request(app.getHttpServer()).get('/analytics').expect(401);
    await get('/analytics', acmeAgent).expect(403);
    await get('/analytics/export', acmeAgent).expect(403);
  });

  it('reports KPIs: AI-resolved vs handed off, response times and ratings', async () => {
    const { kpis, daily, range } = await overview(acmeAdmin, 'tz=UTC&fresh=1');
    expect(range.tz).toBe('UTC');
    expect(kpis).toMatchObject({
      conversations: 4,
      aiResolved: 3,
      handedOff: 1,
      aiResolvedRate: 0.75,
      handoffRate: 0.25,
      aiAnswers: 5,
      thumbsUp: 1,
      thumbsDown: 1,
      satisfactionRate: 0.5,
      // first responses: 2 s, 1 s, 1 s, 1 s
      avgFirstResponseMs: 1250,
      avgAgentResponseMs: 60_000,
    });
    expect(daily).toHaveLength(30);
    expect(daily.reduce((sum, d) => sum + d.conversations, 0)).toBe(4);
  });

  it('lists the questions the AI failed on, grouped by meaning, with counts and reasons', async () => {
    const { unanswered, topQuestions, questionsAnalysed } = await overview(acmeAdmin);
    expect(questionsAnalysed).toBe(4); // "talk to a person" and the playground left out
    const skate = unanswered.find((g) => /skateboards/.test(g.question));
    expect(skate).toMatchObject({
      count: 2,
      reasons: { low_confidence: 0, no_answer: 2, thumbs_down: 0 },
      avgConfidence: 0,
      conversationIds: [handedOffId],
    });
    expect(skate!.examples).toHaveLength(1);
    expect(unanswered.find((g) => /refund/.test(g.question))?.reasons.thumbs_down).toBe(1);
    expect(unanswered.some((g) => /warranty/.test(g.question))).toBe(false);
    expect(topQuestions[0]).toMatchObject({ count: 2, unanswered: 2 });
    expect(topQuestions.find((g) => /warranty/.test(g.question))).toMatchObject({
      count: 1,
      unanswered: 0,
    });
  });

  it('every analytics query is tenant-scoped', async () => {
    const theirs = await overview(otherAdmin, 'tz=UTC&fresh=1');
    expect(theirs.kpis.conversations).toBe(5);
    expect(theirs.unanswered).toEqual([
      expect.objectContaining({ question: 'Do you sell skateboards?', count: 5 }),
    ]);
    expect(JSON.stringify(theirs)).not.toMatch(/warranty|HYPERLINK|v_resolved/);
    const ours = await overview(acmeAdmin, 'tz=UTC&fresh=1');
    expect(ours.unanswered.find((g) => /skateboards/.test(g.question))?.count).toBe(2);
    const ids = ours.unanswered.flatMap((g) => g.conversationIds);
    const owners = await Promise.all(
      ids.map((id) => db.query.conversations.findFirst({ where: eq(conversations.id, id) })),
    );
    expect(owners.every((c) => c?.tenantId === acme.tenantId)).toBe(true);
    // A tenant with no conversations at all.
    const fresh = await createTestTenant('AnalyticsEmpty');
    const token = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: fresh.admin.email, password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken as string;
    const empty = await overview(token);
    expect(empty.kpis).toMatchObject({
      conversations: 0,
      aiResolvedRate: null,
      satisfactionRate: null,
    });
    expect(empty.unanswered).toEqual([]);
  });

  it('caches results for 5 minutes per tenant and range; fresh=1 recalculates', async () => {
    const query = 'tz=UTC&from=2020-01-01&to=2020-01-31';
    const first = await overview(acmeAdmin, `${query}&fresh=1`);
    expect(first.cached).toBe(false);
    expect((await overview(acmeAdmin, query)).cached).toBe(true);
    // Another tenant with the same range gets its own numbers, never Acme's cache entry.
    expect((await overview(otherAdmin, query)).kpis.conversations).toBe(0);
    await conversation(acme.tenantId, 'v_cache_1', [
      { sender: 'customer', content: 'Old question', createdAt: new Date('2020-01-15T12:00:00Z') },
    ]);
    expect((await overview(acmeAdmin, query)).kpis.conversations).toBe(0); // still cached
    expect((await overview(acmeAdmin, `${query}&fresh=1`)).kpis.conversations).toBe(1);
  });

  it('uses the viewer time zone for day boundaries', async () => {
    // 2020-02-01 23:30 UTC is already Feb 2 in Kolkata (+5:30).
    await conversation(acme.tenantId, 'v_tz_1', [
      { sender: 'customer', content: 'Late question', createdAt: new Date('2020-02-01T23:30:00Z') },
    ]);
    const utc = await overview(acmeAdmin, 'tz=UTC&from=2020-02-02&to=2020-02-02&fresh=1');
    const india = await overview(
      acmeAdmin,
      'tz=Asia/Kolkata&from=2020-02-02&to=2020-02-02&fresh=1',
    );
    expect(utc.kpis.conversations).toBe(0);
    expect(india.kpis.conversations).toBe(1);
  });

  it('rejects bad ranges, time zones and report names', async () => {
    await get('/analytics?tz=Mars/Base', acmeAdmin).expect(400);
    await get('/analytics?from=2020-01-01&to=2024-01-01', acmeAdmin).expect(400);
    await get('/analytics?from=2026-10-10&to=2026-10-01', acmeAdmin).expect(400);
    await get('/analytics/export?report=passwords', acmeAdmin).expect(400);
  });

  it('exports CSV files with formulas neutralised', async () => {
    const res = await get('/analytics/export?report=unanswered&tz=UTC', acmeAdmin).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="supportpilot-unanswered-/,
    );
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('question,times_asked,low_confidence');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example`);
    const daily = await get('/analytics/export?report=daily&tz=UTC', acmeAdmin).expect(200);
    expect(daily.text.trim().split('\r\n')).toHaveLength(31); // header + 30 days
  });

  it('customers rate AI answers from the widget, only in their own conversation', async () => {
    const key = await keyOf(acme.tenantId);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, resolvedId));
    const answer = rows.find((r) => r.sender === 'ai')!;
    const question = rows.find((r) => r.sender === 'customer')!;

    const owner = await widget(key, 'v_resolved_1');
    expect(
      await owner.emitWithAck('message:feedback', {
        conversationId: resolvedId,
        messageId: answer.id,
        feedback: 'down',
      }),
    ).toEqual({ ok: true });
    const history = await owner.emitWithAck('conversation:history', { conversationId: resolvedId });
    expect(history.ok && history.messages.find((m) => m.id === answer.id)?.feedback).toBe('down');
    // Only AI answers can be rated.
    expect(
      await owner.emitWithAck('message:feedback', {
        conversationId: resolvedId,
        messageId: question.id,
        feedback: 'up',
      }),
    ).toMatchObject({ ok: false, code: 'conversation_not_found' });
    // Someone else (or the same visitor id on another tenant's widget) cannot rate it.
    const stranger = await widget(key, 'v_stranger_1');
    expect(
      await stranger.emitWithAck('message:feedback', {
        conversationId: resolvedId,
        messageId: answer.id,
        feedback: 'up',
      }),
    ).toMatchObject({ ok: false, code: 'conversation_not_found' });
    const elsewhere = await widget(await keyOf(other.tenantId), 'v_resolved_1');
    expect(
      await elsewhere.emitWithAck('message:feedback', {
        conversationId: resolvedId,
        messageId: answer.id,
        feedback: 'up',
      }),
    ).toMatchObject({ ok: false, code: 'conversation_not_found' });
    expect(
      await owner.emitWithAck('message:feedback', {
        conversationId: resolvedId,
        feedback: 'up',
      } as never),
    ).toMatchObject({ ok: false, code: 'invalid' });
    const stored = await db.query.messages.findFirst({ where: eq(messages.id, answer.id) });
    expect(stored?.feedback).toBe('down');

    // Taking the rating back.
    await owner.emitWithAck('message:feedback', {
      conversationId: resolvedId,
      messageId: answer.id,
      feedback: null,
    });
    expect(
      (await db.query.messages.findFirst({ where: eq(messages.id, answer.id) }))?.feedback,
    ).toBe(null);
  });

  it('remembers the first hand-off after the chat is handed back to the AI', async () => {
    const s = await widget(await keyOf(acme.tenantId), 'v_live_handoff');
    const done = new Promise<ChatDone>((resolve) => s.once('message:done', resolve));
    const ack = await s.emitWithAck('message:send', { message: 'Can I talk to a real person?' });
    expect(ack.ok).toBe(true);
    const { conversationId } = await done;
    const waiting = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.firstHandoffAt).toBeInstanceOf(Date);
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/hand-back`)
      .set('Authorization', `Bearer ${acmeAgent}`)
      .expect(200);
    const back = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
    expect(back).toMatchObject({ status: 'ai', handoffReason: null });
    expect(back?.firstHandoffAt?.getTime()).toBe(waiting!.firstHandoffAt!.getTime());
  });

  it('"Add doc" writes a short article into the knowledge base (admins only)', async () => {
    const body = {
      title: 'Do you sell skateboards?',
      content: 'No, Acme Bikes only sells bicycles and e-bikes.',
    };
    await request(app.getHttpServer())
      .post('/documents/text')
      .set('Authorization', `Bearer ${acmeAgent}`)
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post('/documents/text')
      .set('Authorization', `Bearer ${acmeAdmin}`)
      .send({ title: 'x', content: 'short' })
      .expect(400);
    const res = await request(app.getHttpServer())
      .post('/documents/text')
      .set('Authorization', `Bearer ${acmeAdmin}`)
      .send(body)
      .expect(201);
    expect(res.body).toMatchObject({
      title: 'Do you sell skateboards?',
      sourceType: 'text',
      source: 'do-you-sell-skateboards.md',
      status: 'queued',
    });
    const row = await db.query.documents.findFirst({ where: eq(documents.id, res.body.id) });
    expect(row).toMatchObject({ tenantId: acme.tenantId, mimeType: 'text/markdown' });
  });
});
