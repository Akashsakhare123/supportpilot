import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  conversations,
  createDb,
  createPool,
  eq,
  messages,
  tenants,
  type Database,
  type Pool,
} from '@supportpilot/db';
import type {
  AgentClientEvents,
  AgentPresence,
  AgentServerEvents,
  ConversationDetail,
  ConversationSummary,
  MessagePage,
  AgentMessage,
  WidgetClientEvents,
  WidgetServerEvents,
} from '@supportpilot/shared';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { PresenceService, presenceKeys } from '../src/realtime/presence.service';
import { createTestApp, createTestTenant, TEST_PASSWORD, type TestTenant } from './helpers';

type WidgetSocket = Socket<WidgetServerEvents, WidgetClientEvents>;
type AgentSocket = Socket<AgentServerEvents, AgentClientEvents>;
type AgentTyping = Parameters<AgentServerEvents['typing']>[0];

interface Listenable {
  on(event: string, listener: (payload: never) => void): unknown;
  off(event: string, listener: (payload: never) => void): unknown;
}

/** Resolve on the first event matching the predicate (or fail after a timeout). */
function nextEvent<T>(
  target: unknown,
  event: string,
  match: (payload: T) => boolean = () => true,
  timeoutMs = 3_000,
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

/** True if no matching event arrives within the window. */
async function silent(target: unknown, event: string, windowMs = 400): Promise<boolean> {
  return nextEvent(target, event, () => true, windowMs).then(
    () => false,
    () => true,
  );
}

const stateOf = (agents: AgentPresence[], userId: string) =>
  agents.find((a) => a.userId === userId)?.state;

describe('Typing, presence and history (T11)', () => {
  // Two API instances: typing and presence must cross instances through Redis.
  let appA: INestApplication;
  let appB: INestApplication;
  let urlA: string;
  let urlB: string;
  let pool: Pool;
  let db: Database;
  let redis: Redis;
  let acme: TestTenant;
  let key: string;
  const tokens: Record<string, string> = {};
  const sockets: { disconnect(): unknown }[] = [];

  const api = (token: string) => ({
    get: (u: string) =>
      request(appA.getHttpServer()).get(u).set('Authorization', `Bearer ${token}`),
    post: (u: string, body?: object) =>
      request(appA.getHttpServer())
        .post(u)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
  });

  async function widget(url: string, visitorId: string): Promise<WidgetSocket> {
    const s: WidgetSocket = io(`${url}/widget`, {
      auth: { key, visitorId },
      extraHeaders: { origin: 'https://shop.example' },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return s;
  }

  async function agent(url: string, token: string, presence?: 'online' | 'away') {
    const s: AgentSocket = io(`${url}/agent`, {
      auth: { token, presence },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    const snapshot = nextEvent<{ agents: AgentPresence[] }>(s, 'presence:update');
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    await snapshot;
    return s;
  }

  /** A conversation of `visitorId` with `count` customer / agent messages one second apart. */
  async function seedConversation(
    visitorId: string,
    count: number,
    status: 'ai' | 'waiting' | 'human' = 'waiting',
  ) {
    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: acme.tenantId, visitorId, status, origin: 'https://shop.example' })
      .returning();
    const start = Date.now() - count * 1_000 - 60_000;
    const rows = Array.from({ length: count }, (_, i) => ({
      tenantId: acme.tenantId,
      conversationId: conversation!.id,
      sender: (i % 10 === 9 ? 'system' : i % 2 === 0 ? 'customer' : 'agent') as
        'customer' | 'agent' | 'system',
      content: `message ${i + 1}`,
      createdAt: new Date(start + i * 1_000),
    }));
    const inserted = await db.insert(messages).values(rows).returning();
    return { id: conversation!.id, messages: inserted };
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
    redis = new Redis(process.env.REDIS_URL!);
    acme = await createTestTenant('LiveAcme');
    key = (await db.query.tenants.findFirst({ where: eq(tenants.id, acme.tenantId) }))!.publicKey;
    const login = async (email: string) =>
      (
        await request(appA.getHttpServer())
          .post('/auth/login')
          .send({ email, password: TEST_PASSWORD })
          .expect(200)
      ).body.accessToken as string;
    tokens.agent = await login(acme.agent.email);
    tokens.admin = await login(acme.admin.email);
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    // Let the servers process the disconnects (presence keys are deleted on disconnect).
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  afterAll(async () => {
    redis?.disconnect();
    await pool?.end();
    await appA?.close();
    await appB?.close();
  });

  it('relays typing both ways in well under 300 ms, across instances', async () => {
    const { id } = await seedConversation('visitor_live_typing', 2, 'human');
    const dashboard = await agent(urlA, tokens.agent);
    const visitor = await widget(urlB, 'visitor_live_typing');
    const history = await visitor.emitWithAck('conversation:history', { conversationId: id });
    expect(history.ok).toBe(true);

    let started = Date.now();
    const customerTyping = nextEvent<AgentTyping>(dashboard, 'typing', (e) => e.typing);
    visitor.emit('typing', { conversationId: id, typing: true });
    expect(await customerTyping).toMatchObject({ conversationId: id, from: 'customer' });
    expect(Date.now() - started).toBeLessThan(300);

    started = Date.now();
    const agentTyping = nextEvent<{ typing: boolean; name: string | null }>(visitor, 'typing');
    dashboard.emit('typing', { conversationId: id, typing: true });
    expect(await agentTyping).toMatchObject({ typing: true, name: 'agent' });
    expect(Date.now() - started).toBeLessThan(300);

    const stopped = nextEvent<{ typing: boolean }>(visitor, 'typing');
    dashboard.emit('typing', { conversationId: id, typing: false });
    expect((await stopped).typing).toBe(false);
  });

  it("ignores typing for conversations the sender doesn't own", async () => {
    const { id } = await seedConversation('visitor_live_owner', 2);
    const dashboard = await agent(urlA, tokens.agent);
    // Another visitor who never loaded this conversation.
    const stranger = await widget(urlA, 'visitor_live_stranger');
    stranger.emit('typing', { conversationId: id, typing: true });
    expect(await silent(dashboard, 'typing')).toBe(true);

    // Another tenant's agent typing into this conversation reaches nobody.
    const other = await createTestTenant('LiveOther');
    const otherToken = (
      await request(appA.getHttpServer())
        .post('/auth/login')
        .send({ email: other.agent.email, password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken as string;
    const owner = await widget(urlA, 'visitor_live_owner');
    await owner.emitWithAck('conversation:history', { conversationId: id });
    const intruder = await agent(urlA, otherToken);
    intruder.emit('typing', { conversationId: id, typing: true });
    expect(await silent(owner, 'typing')).toBe(true);
  });

  it('presence: widget sees agents come online, go away and go offline when the tab closes', async () => {
    // The widget is told on connect whether anyone is online (nobody yet).
    const s: WidgetSocket = io(`${urlA}/widget`, {
      auth: { key, visitorId: 'visitor_live_presence' },
      extraHeaders: { origin: 'https://shop.example' },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(s);
    expect(await nextEvent<{ agentsOnline: boolean }>(s, 'presence')).toEqual({
      agentsOnline: false,
    });
    const visitor = s;

    const online = nextEvent<{ agentsOnline: boolean }>(visitor, 'presence', (p) => p.agentsOnline);
    const admin = await agent(urlB, tokens.admin, 'away');
    const dashboard = await agent(urlB, tokens.agent);
    await online;

    const away = nextEvent<{ agents: AgentPresence[] }>(
      admin,
      'presence:update',
      (p) => stateOf(p.agents, acme.agent.id) === 'away',
    );
    const nobody = nextEvent<{ agentsOnline: boolean }>(
      visitor,
      'presence',
      (p) => !p.agentsOnline,
    );
    dashboard.emit('presence:set', { state: 'away' });
    await away;
    await nobody;

    const offline = nextEvent<{ agents: AgentPresence[] }>(
      admin,
      'presence:update',
      (p) => stateOf(p.agents, acme.agent.id) === 'offline',
    );
    dashboard.disconnect();
    await offline;
  });

  it('presence: a crashed tab goes offline when its Redis key expires (TTL)', async () => {
    const visitor = await widget(urlA, 'visitor_live_crash');
    const online = nextEvent<{ agentsOnline: boolean }>(visitor, 'presence', (p) => p.agentsOnline);
    const dashboard = await agent(urlA, tokens.agent);
    await online;
    const presence = appA.get(PresenceService);
    expect(await presence.onlineCount(acme.tenantId)).toBe(1);

    // No disconnect and no more heartbeats: simulate the 30 s TTL running out.
    const tabKey = presenceKeys.tab(acme.tenantId, acme.agent.id, dashboard.id!);
    expect(await redis.get(tabKey)).toBe('online');
    const gone = nextEvent<{ agentsOnline: boolean }>(visitor, 'presence', (p) => !p.agentsOnline);
    await redis.pexpire(tabKey, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await presence.sweep();
    await gone;
    expect(await presence.onlineCount(acme.tenantId)).toBe(0);

    // A heartbeat from the same tab brings it back.
    const back = nextEvent<{ agentsOnline: boolean }>(visitor, 'presence', (p) => p.agentsOnline);
    dashboard.emit('presence:heartbeat');
    await back;
  });

  it('an agent who is away does not count as online for hand-offs', async () => {
    await agent(urlA, tokens.agent, 'away');
    const visitor = await widget(urlA, 'visitor_live_away');
    const status = nextEvent<{ status: string; agentsOnline?: boolean }>(
      visitor,
      'conversation:status',
    );
    const ack = await visitor.emitWithAck('message:send', { message: 'Talk to a person please' });
    expect(ack.ok).toBe(true);
    expect(await status).toMatchObject({ status: 'waiting', agentsOnline: false });
  });

  it('widget history: latest page, older pages, missed messages; system notes hidden', async () => {
    const { id, messages: all } = await seedConversation('visitor_live_history', 70);
    const visible = all.filter((m) => m.sender !== 'system');
    expect(visible).toHaveLength(63);
    const visitor = await widget(urlA, 'visitor_live_history');

    const latest = await visitor.emitWithAck('conversation:history', { conversationId: id });
    if (!latest.ok) throw new Error(latest.message);
    expect(latest.messages).toHaveLength(50);
    expect(latest.hasMore).toBe(true);
    expect(latest.messages.map((m) => m.id)).toEqual(visible.slice(13).map((m) => m.id));
    expect(latest.status).toBe('waiting');

    const older = await visitor.emitWithAck('conversation:history', {
      conversationId: id,
      before: latest.messages[0]!.id,
    });
    if (!older.ok) throw new Error(older.message);
    expect(older.messages.map((m) => m.id)).toEqual(visible.slice(0, 13).map((m) => m.id));
    expect(older.hasMore).toBe(false);

    const missed = await visitor.emitWithAck('conversation:history', {
      conversationId: id,
      after: visible[60]!.id,
    });
    if (!missed.ok) throw new Error(missed.message);
    expect(missed.messages.map((m) => m.id)).toEqual(visible.slice(61).map((m) => m.id));
    expect(missed.hasMore).toBe(false);

    const bad = await visitor.emitWithAck('conversation:history', {
      conversationId: id,
      before: '00000000-0000-4000-8000-000000000000',
    });
    expect(bad).toMatchObject({ ok: false, code: 'invalid' });
    const stranger = await widget(urlA, 'visitor_live_other');
    expect(
      await stranger.emitWithAck('conversation:history', { conversationId: id }),
    ).toMatchObject({ ok: false, code: 'conversation_not_found' });
  });

  it('agent view: paged detail, older pages and missed messages over REST', async () => {
    const { id, messages: all } = await seedConversation('visitor_live_agent_history', 70);
    const detail = (await api(tokens.agent).get(`/conversations/${id}`).expect(200))
      .body as ConversationDetail;
    expect(detail.messages).toHaveLength(50);
    expect(detail.hasMore).toBe(true);
    expect(detail.messages.at(-1)!.id).toBe(all.at(-1)!.id);

    const older = (
      await api(tokens.agent)
        .get(`/conversations/${id}/messages?before=${detail.messages[0]!.id}`)
        .expect(200)
    ).body as MessagePage<AgentMessage>;
    expect(older.messages.map((m) => m.id)).toEqual(all.slice(0, 20).map((m) => m.id));
    expect(older.hasMore).toBe(false);

    const missed = (
      await api(tokens.agent).get(`/conversations/${id}/messages?after=${all[67]!.id}`).expect(200)
    ).body as MessagePage<AgentMessage>;
    expect(missed.messages.map((m) => m.id)).toEqual(all.slice(68).map((m) => m.id));

    await api(tokens.agent)
      .get(`/conversations/${id}/messages?before=${all[1]!.id}&after=${all[0]!.id}`)
      .expect(400);
    await api(tokens.agent)
      .get(`/conversations/${id}/messages?before=00000000-0000-4000-8000-000000000000`)
      .expect(404);
  });

  it('read receipts and unread counts in both directions', async () => {
    const { id } = await seedConversation('visitor_live_read', 4); // customer, agent, customer, agent
    const visitor = await widget(urlB, 'visitor_live_read');
    const history = await visitor.emitWithAck('conversation:history', { conversationId: id });
    if (!history.ok) throw new Error(history.message);
    expect(history.unread).toBe(2); // the visitor never had the chat open
    expect(history.agentReadAt).toBeNull();

    const before = (await api(tokens.agent).get(`/conversations/${id}`).expect(200))
      .body as ConversationDetail;
    expect(before.conversation.unreadCount).toBe(2);

    // The agent opens it: unread cleared, the widget gets a read receipt.
    const receipt = nextEvent<{ conversationId: string; readAt: string }>(
      visitor,
      'conversation:read',
    );
    const read = (await api(tokens.agent).post(`/conversations/${id}/read`).expect(200))
      .body as ConversationSummary;
    expect(read.unreadCount).toBe(0);
    expect((await receipt).conversationId).toBe(id);

    // The visitor opens the chat: dashboards see visitorReadAt (for "Seen").
    const dashboard = await agent(urlA, tokens.agent);
    const upsert = nextEvent<ConversationSummary>(
      dashboard,
      'conversation:upsert',
      (s) => s.id === id && s.visitorReadAt !== null,
    );
    visitor.emit('conversation:read', { conversationId: id });
    await upsert;
    const again = await visitor.emitWithAck('conversation:history', { conversationId: id });
    if (!again.ok) throw new Error(again.message);
    expect(again.unread).toBe(0);
    expect(again.agentReadAt).not.toBeNull();

    // A new customer message makes it unread again for the team.
    await db.insert(messages).values({
      tenantId: acme.tenantId,
      conversationId: id,
      sender: 'customer',
      content: 'Anyone there?',
    });
    const after = (await api(tokens.agent).get(`/conversations/${id}`).expect(200))
      .body as ConversationDetail;
    expect(after.conversation.unreadCount).toBe(1);

    // Another tenant cannot mark it read (or even see it).
    const other = await createTestTenant('LiveReadOther');
    const otherToken = (
      await request(appA.getHttpServer())
        .post('/auth/login')
        .send({ email: other.agent.email, password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken as string;
    await api(otherToken).post(`/conversations/${id}/read`).expect(404);
  });

  describe('every new request checks who is asking', () => {
    let otherToken: string;
    let otherTenantId: string;

    beforeAll(async () => {
      const other = await createTestTenant('LivePermOther');
      otherTenantId = other.tenantId;
      otherToken = (
        await request(appA.getHttpServer())
          .post('/auth/login')
          .send({ email: other.agent.email, password: TEST_PASSWORD })
          .expect(200)
      ).body.accessToken as string;
    });

    it('REST: login required, other tenants get 404, bad ids and cursors get 400', async () => {
      const { id, messages: all } = await seedConversation('visitor_live_perm_rest', 4);
      const http = () => request(appA.getHttpServer());
      await http().get(`/conversations/${id}/messages`).expect(401);
      await http().post(`/conversations/${id}/read`).expect(401);
      await http()
        .get(`/conversations/${id}/messages`)
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);

      await api(otherToken).get(`/conversations/${id}`).expect(404);
      await api(otherToken).get(`/conversations/${id}/messages`).expect(404);
      await api(otherToken).get(`/conversations/${id}/messages?after=${all[0]!.id}`).expect(404);
      await api(otherToken).post(`/conversations/${id}/read`).expect(404);

      await api(tokens.agent).get('/conversations/not-a-uuid/messages').expect(400);
      await api(tokens.agent).get(`/conversations/${id}/messages?before=nope`).expect(400);
      await api(tokens.agent).get(`/conversations/${id}/messages?limit=1000`).expect(400);

      // The other tenant's attempt changed nothing.
      const row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
      expect(row!.agentReadAt).toBeNull();
      // Every role on the team (agent and up) may read.
      await api(tokens.agent).get(`/conversations/${id}/messages`).expect(200);
      await api(tokens.admin).post(`/conversations/${id}/read`).expect(200);
    });

    it('agent socket: refuses forged tokens and users outside the tenant in the token', async () => {
      const jwt = appA.get(JwtService);
      const refused = (token: string) =>
        new Promise<string>((resolve, reject) => {
          const s = io(`${urlA}/agent`, {
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
          });
          sockets.push(s);
          s.once('connect', () => reject(new Error('should have been refused')));
          s.once('connect_error', (error) => resolve(error.message));
        });
      // Signed with the right secret, but for a user that does not exist.
      const ghost = await jwt.signAsync({ sub: randomUUID(), tid: acme.tenantId, role: 'owner' });
      expect(await refused(ghost)).toMatch(/Invalid or expired/);
      // A real user, but claiming another tenant.
      const wrongTenant = await jwt.signAsync({
        sub: acme.agent.id,
        tid: otherTenantId,
        role: 'agent',
      });
      expect(await refused(wrongTenant)).toMatch(/Invalid or expired/);
      // Signed with another secret.
      const forged = new JwtService({ secret: 'not-the-real-secret' }).sign({
        sub: acme.agent.id,
        tid: acme.tenantId,
        role: 'owner',
      });
      expect(await refused(forged)).toMatch(/Invalid or expired/);
      expect(await appA.get(PresenceService).onlineCount(acme.tenantId)).toBe(0);
    });

    it('live events never cross tenants', async () => {
      const { id } = await seedConversation('visitor_live_perm_rooms', 2, 'human');
      const outsider = await agent(urlA, otherToken);
      const visitor = await widget(urlB, 'visitor_live_perm_rooms');
      await visitor.emitWithAck('conversation:history', { conversationId: id });

      const leaks: string[] = [];
      for (const event of ['typing', 'presence:update', 'conversation:upsert', 'message:new']) {
        outsider.on(event as 'typing', () => leaks.push(event));
      }
      const dashboard = await agent(urlB, tokens.agent); // presence change in acme
      visitor.emit('typing', { conversationId: id, typing: true });
      dashboard.emit('typing', { conversationId: id, typing: true });
      visitor.emit('conversation:read', { conversationId: id });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(leaks).toEqual([]);
    });

    it('widget: read receipts only for its own conversations; bad payloads and floods are dropped', async () => {
      const { id } = await seedConversation('visitor_live_perm_owner', 2);
      const dashboard = await agent(urlA, tokens.agent);

      // A visitor who does not own the conversation cannot mark it read.
      const stranger = await widget(urlA, 'visitor_live_perm_stranger');
      stranger.emit('conversation:read', { conversationId: id });
      expect(
        await stranger.emitWithAck('conversation:history', { conversationId: id }),
      ).toMatchObject({ ok: false, code: 'conversation_not_found' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      let row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
      expect(row!.visitorReadAt).toBeNull();

      // Malformed events are ignored, and the connection stays usable.
      const owner = await widget(urlA, 'visitor_live_perm_owner');
      await owner.emitWithAck('conversation:history', { conversationId: id });
      (owner as unknown as Socket).emit('typing', { conversationId: id, typing: 'yes', extra: 1 });
      (owner as unknown as Socket).emit('conversation:read', 'nope');
      (dashboard as unknown as Socket).emit('presence:set', { state: 'offline' });
      (dashboard as unknown as Socket).emit('typing', null);
      expect(await silent(dashboard, 'typing', 300)).toBe(true);
      expect(await appA.get(PresenceService).onlineCount(acme.tenantId)).toBe(1);

      // A typing flood: at most 20 events per 10 seconds get through.
      let received = 0;
      dashboard.on('typing', () => received++);
      for (let i = 0; i < 60; i++)
        owner.emit('typing', { conversationId: id, typing: i % 2 === 0 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(received).toBe(20);

      owner.emit('conversation:read', { conversationId: id });
      await new Promise((resolve) => setTimeout(resolve, 300));
      row = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
      expect(row!.visitorReadAt).not.toBeNull();
    });
  });
});
