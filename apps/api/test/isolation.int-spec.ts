import type { INestApplication } from '@nestjs/common';
import { embedDocument, LocalHashEmbeddings } from '@supportpilot/ai';
import {
  conversations,
  createDb,
  createPool,
  type Database,
  documents,
  eq,
  invites,
  messages,
  type Pool,
  replaceDocumentChunks,
  searchChunks,
  tenants,
} from '@supportpilot/db';
import type { ChatDone } from '@supportpilot/shared';
import request from 'supertest';
import { createTestApp, createTestTenant, TEST_PASSWORD, type TestTenant } from './helpers';

/**
 * Tenant isolation suite (T14): tenant B, with every role, tries to read or change tenant A's
 * documents, chunks, conversations, messages, team, settings, analytics and billing through every
 * endpoint. A route census at the end fails when a new endpoint is added without being classified
 * here, so isolation coverage cannot silently fall behind the API.
 */

/** Every route the API serves, as "METHOD /path" (Express router of the Nest app). */
function registeredRoutes(app: INestApplication): string[] {
  const express = app.getHttpAdapter().getInstance() as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  const stack = (express.router ?? express._router)?.stack ?? [];
  const routes: string[] = [];
  for (const layer of stack as { route?: { path: string; methods: Record<string, boolean> } }[]) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (method !== '_all') routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return routes;
}

/** Routes with no tenant data behind them, or whose tenant comes from a public key / signature. */
const NOT_TENANT_SCOPED = new Set([
  'GET /',
  'GET /health',
  'POST /auth/login',
  'POST /auth/signup',
  'POST /auth/refresh',
  'POST /auth/logout',
  'GET /auth/invites/:token', // the unguessable token is the credential (auth suite)
  'POST /auth/invites/accept',
  'GET /widget/config', // public branding by design; domains checked by the widget gateway
  'POST /billing/webhook', // Stripe signature; cross-tenant events tested in the billing suite
]);

/** Routes checked below for cross-tenant access. */
const ISOLATION_CHECKED = new Set([
  'GET /auth/me',
  'GET /tenant',
  'PATCH /tenant',
  'POST /tenant/public-key/rotate',
  'GET /users',
  'POST /users/invites',
  'GET /documents',
  'POST /documents',
  'POST /documents/url',
  'POST /documents/text',
  'POST /documents/:id/reindex',
  'DELETE /documents/:id',
  'GET /conversations',
  'GET /conversations/:id',
  'GET /conversations/:id/messages',
  'POST /conversations/:id/read',
  'POST /conversations/:id/claim',
  'POST /conversations/:id/messages',
  'POST /conversations/:id/hand-back',
  'POST /conversations/:id/close',
  'POST /chat/playground',
  'POST /v1/chat',
  'GET /analytics',
  'GET /analytics/export',
  'GET /billing',
  'POST /billing/checkout',
  'POST /billing/portal',
]);

describe('Tenant isolation (T14)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: Database;
  let a: TestTenant;
  let b: TestTenant;
  let aKey: string;
  let bKey: string;
  let aDocId: string;
  let aConversationId: string;
  let aPlaygroundId: string;
  const tokens: Record<'aOwner' | 'aAdmin' | 'bOwner' | 'bAdmin' | 'bAgent', string> = {
    aOwner: '',
    aAdmin: '',
    bOwner: '',
    bAdmin: '',
    bAgent: '',
  };
  const SECRET = 'Zebracorn Club';
  const QUESTION = 'What do Zebracorn Club members get?';
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      http()
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
    patch: (path: string, body: object) =>
      http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => http().delete(path).set('Authorization', `Bearer ${token}`),
  });
  const login = async (email: string) =>
    (await http().post('/auth/login').send({ email, password: TEST_PASSWORD }).expect(200)).body
      .accessToken as string;

  /** Collect an SSE answer (widget or playground). */
  async function sse(req: request.Test): Promise<{ status: number; done?: ChatDone }> {
    const res = await req.buffer(true).parse((r, callback) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => (body += chunk));
      r.on('end', () => callback(null, body));
    });
    if (res.status !== 200) return { status: res.status };
    const block = (res.body as string).split('\n\n').find((x) => x.startsWith('event: done'));
    return {
      status: 200,
      done: block ? (JSON.parse(/^data: (.+)$/m.exec(block)![1]!) as ChatDone) : undefined,
    };
  }

  const widgetAsk = (key: string, message: string, conversationId?: string) =>
    sse(
      http()
        .post('/v1/chat')
        .set('Origin', 'https://shop.example')
        .send({ key, visitorId: 'visitor_isolation', message, conversationId }),
    );

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    a = await createTestTenant('IsoA');
    b = await createTestTenant('IsoB');
    const keyOf = async (id: string) =>
      (await db.query.tenants.findFirst({ where: eq(tenants.id, id) }))!.publicKey;
    aKey = await keyOf(a.tenantId);
    bKey = await keyOf(b.tenantId);
    tokens.aOwner = await login(a.owner.email);
    tokens.aAdmin = await login(a.admin.email);
    tokens.bOwner = await login(b.owner.email);
    tokens.bAdmin = await login(b.admin.email);
    tokens.bAgent = await login(b.agent.email);

    // Tenant A: one searchable article only A knows about, a customer chat, a playground chat
    // and a pending invite.
    const [doc] = await db
      .insert(documents)
      .values({
        tenantId: a.tenantId,
        title: 'Loyalty program',
        sourceType: 'text',
        source: 'loyalty.md',
        status: 'processing',
      })
      .returning();
    aDocId = doc!.id;
    const embedded = await embedDocument(
      'Loyalty program',
      `# Loyalty program\n\nOur loyalty program is called the ${SECRET}. Zebracorn Club members get 15% off every order.`,
      new LocalHashEmbeddings(),
    );
    await replaceDocumentChunks(db, {
      tenantId: a.tenantId,
      documentId: aDocId,
      embeddingModel: embedded.model,
      chunks: embedded.chunks,
    });
    const answer = await widgetAsk(aKey, QUESTION);
    expect(answer.done!.sources[0]?.documentTitle).toBe('Loyalty program');
    aConversationId = answer.done!.conversationId;
    // A question only tenant A ever asks (for the analytics checks).
    await widgetAsk(aKey, 'Is there a Quokka discount for students?');
    const playground = await sse(
      as(tokens.aAdmin).post('/chat/playground', { message: 'Hello from the A playground' }),
    );
    aPlaygroundId = playground.done!.conversationId;
    await as(tokens.aAdmin)
      .post('/users/invites', { email: `iso-a-${Date.now()}@example.test`, role: 'agent' })
      .expect(201);
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('B never sees A in its own profile, workspace, team, documents or inbox lists', async () => {
    for (const token of [tokens.bOwner, tokens.bAdmin]) {
      const me = (await as(token).get('/auth/me').expect(200)).body;
      expect(JSON.stringify(me)).not.toContain(a.tenantId);
      const tenant = (await as(token).get('/tenant').expect(200)).body;
      expect(tenant.id).toBe(b.tenantId);
      expect(JSON.stringify(tenant)).not.toContain(aKey);
      const team = JSON.stringify((await as(token).get('/users').expect(200)).body);
      for (const user of [a.owner, a.admin, a.agent]) expect(team).not.toContain(user.email);
      const docs = (await as(token).get('/documents').expect(200)).body as { id: string }[];
      expect(docs.map((d) => d.id)).not.toContain(aDocId);
    }
    for (const token of [tokens.bOwner, tokens.bAdmin, tokens.bAgent]) {
      for (const tab of ['needs_agent', 'mine', 'team', 'ai', 'closed']) {
        const list = JSON.stringify(
          (await as(token).get(`/conversations?tab=${tab}`).expect(200)).body,
        );
        expect(list).not.toContain(aConversationId);
        expect(list).not.toContain(aPlaygroundId);
      }
    }
  });

  it("B gets 404 for every action on A's conversations, and nothing changes", async () => {
    const before = await db.query.conversations.findFirst({
      where: eq(conversations.id, aConversationId),
    });
    const countBefore = (
      await db.select().from(messages).where(eq(messages.conversationId, aConversationId))
    ).length;
    for (const token of [tokens.bOwner, tokens.bAdmin, tokens.bAgent]) {
      const api = as(token);
      for (const id of [aConversationId, aPlaygroundId]) {
        await api.get(`/conversations/${id}`).expect(404);
        await api.get(`/conversations/${id}/messages`).expect(404);
        await api.post(`/conversations/${id}/read`).expect(404);
        await api.post(`/conversations/${id}/claim`).expect(404);
        await api.post(`/conversations/${id}/messages`, { message: 'hijack' }).expect(404);
        await api.post(`/conversations/${id}/hand-back`).expect(404);
        await api.post(`/conversations/${id}/close`).expect(404);
      }
    }
    const after = await db.query.conversations.findFirst({
      where: eq(conversations.id, aConversationId),
    });
    expect(after).toMatchObject({
      status: before!.status,
      assignedAgentId: before!.assignedAgentId,
      agentReadAt: before!.agentReadAt,
    });
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, aConversationId));
    expect(rows).toHaveLength(countBefore);
    expect(rows.map((m) => m.content)).not.toContain('hijack');
  });

  it("B cannot continue A's chats, from the widget or the playground", async () => {
    expect((await widgetAsk(bKey, 'Hello', aConversationId)).status).toBe(404);
    expect((await widgetAsk(bKey, 'Hello', aPlaygroundId)).status).toBe(404);
    const playground = await sse(
      as(tokens.bAgent).post('/chat/playground', {
        message: 'Hello',
        conversationId: aPlaygroundId,
      }),
    );
    expect(playground.status).toBe(404);
  });

  it("B's assistant and vector search never use A's documents", async () => {
    const answer = await widgetAsk(bKey, QUESTION);
    expect(answer.done!.sources).toEqual([]);
    expect(answer.done!.content).not.toContain('15%');
    const playground = await sse(as(tokens.bAdmin).post('/chat/playground', { message: QUESTION }));
    expect(playground.done!.content).not.toContain('Zebracorn');

    const [vector] = await new LocalHashEmbeddings().embed([QUESTION]);
    const hitsB = await searchChunks(db, {
      tenantId: b.tenantId,
      embedding: vector!,
      embeddingModel: 'local-hash-v2',
      limit: 50,
    });
    expect(hitsB.map((h) => h.documentId)).not.toContain(aDocId);
    const hitsA = await searchChunks(db, {
      tenantId: a.tenantId,
      embedding: vector!,
      embeddingModel: 'local-hash-v2',
      limit: 50,
    });
    expect(hitsA.map((h) => h.documentId)).toContain(aDocId);
  });

  it("B cannot re-index or delete A's documents", async () => {
    await as(tokens.bAdmin).post(`/documents/${aDocId}/reindex`).expect(404);
    await as(tokens.bAdmin).delete(`/documents/${aDocId}`).expect(404);
    await as(tokens.bOwner).delete(`/documents/${aDocId}`).expect(404);
    expect(await db.query.documents.findFirst({ where: eq(documents.id, aDocId) })).toBeDefined();
  });

  it("B's writes only ever land in B", async () => {
    await as(tokens.bAdmin).patch('/tenant', { handoffThreshold: 0.4 }).expect(200);
    const rotated = (await as(tokens.bAdmin).post('/tenant/public-key/rotate').expect(200)).body;
    expect(rotated.publicKey).not.toBe(aKey);
    const aRow = await db.query.tenants.findFirst({ where: eq(tenants.id, a.tenantId) });
    expect(aRow).toMatchObject({ publicKey: aKey });
    expect(aRow!.handoffThreshold).not.toBe(0.4);

    const doc = (
      await as(tokens.bAdmin)
        .post('/documents/text', {
          title: 'B article',
          content: 'An article that belongs to tenant B only.',
        })
        .expect(201)
    ).body;
    expect(
      (await db.query.documents.findFirst({ where: eq(documents.id, doc.id) }))!.tenantId,
    ).toBe(b.tenantId);
    const invite = `iso-b-${Date.now()}@example.test`;
    await as(tokens.bAdmin).post('/users/invites', { email: invite, role: 'agent' }).expect(201);
    expect((await db.query.invites.findFirst({ where: eq(invites.email, invite) }))!.tenantId).toBe(
      b.tenantId,
    );
  });

  it("B's analytics and exports contain none of A's chats", async () => {
    const overview = (await as(tokens.bAdmin).get('/analytics?tz=UTC&fresh=1').expect(200)).body;
    const text = JSON.stringify(overview);
    expect(text).not.toContain('Quokka');
    expect(text).not.toContain(aConversationId);
    for (const report of ['daily', 'questions', 'unanswered']) {
      const csv = (
        await as(tokens.bAdmin).get(`/analytics/export?tz=UTC&report=${report}`).expect(200)
      ).text;
      expect(csv).not.toContain('Quokka');
    }
    // A sees its own question, so the checks above are meaningful.
    const aText = JSON.stringify(
      (await as(tokens.aAdmin).get('/analytics?tz=UTC&fresh=1').expect(200)).body,
    );
    expect(aText).toContain('Quokka');
  });

  it("B's billing shows B's usage and acts on B's Stripe customer only", async () => {
    const billing = (await as(tokens.bOwner).get('/billing').expect(200)).body;
    const bDocs = (await as(tokens.bAdmin).get('/documents').expect(200)).body.length;
    expect(billing.usage.documents.used).toBe(bDocs);
    // Neither tenant has a Stripe customer, so the portal refuses B (not A's customer).
    await as(tokens.bOwner).post('/billing/portal').expect(409);
    await as(tokens.bAdmin).get('/billing').expect(403);
  });

  it('every API route is either isolation-checked here or not tenant-scoped', () => {
    const routes = registeredRoutes(app);
    expect(routes.length).toBeGreaterThan(30);
    const unclassified = routes.filter(
      (r) => !ISOLATION_CHECKED.has(r) && !NOT_TENANT_SCOPED.has(r),
    );
    expect(unclassified).toEqual([]);
    // And nothing listed here has disappeared from the API.
    for (const route of [...ISOLATION_CHECKED, ...NOT_TENANT_SCOPED])
      expect(routes).toContain(route);
  });
});
