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
import type { ChatDone, WidgetClientEvents, WidgetServerEvents } from '@supportpilot/shared';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { createTestApp, createTestTenant, type TestTenant } from './helpers';

type ClientSocket = Socket<WidgetServerEvents, WidgetClientEvents>;
const SEED_DIR = path.resolve(__dirname, '../../../packages/db/seed-data/acme-bikes');

describe('Widget live chat over Socket.io (T08)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: Database;
  let acme: TestTenant;
  let key: string;
  let baseUrl: string;
  const sockets: ClientSocket[] = [];

  function connect(
    auth: { key?: string; visitorId?: string },
    origin = 'https://shop.example',
  ): ClientSocket {
    const socket: ClientSocket = io(`${baseUrl}/widget`, {
      auth,
      extraHeaders: { origin },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  }

  function connected(socket: ClientSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (error) => reject(error));
    });
  }

  function refused(socket: ClientSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      socket.once('connect', () => reject(new Error('should have been refused')));
      socket.once('connect_error', (error) => resolve(error.message));
    });
  }

  /** Send a message and collect the streamed answer. */
  async function ask(socket: ClientSocket, message: string, conversationId?: string) {
    const deltas: string[] = [];
    const onDelta = ({ text }: { text: string }) => deltas.push(text);
    socket.on('message:delta', onDelta);
    const done = new Promise<ChatDone>((resolve) => socket.once('message:done', resolve));
    const ack = await socket.emitWithAck('message:send', { message, conversationId });
    if (!ack.ok) {
      socket.off('message:delta', onDelta);
      return { ack, deltas, done: null };
    }
    const result = await done;
    socket.off('message:delta', onDelta);
    return { ack, deltas, done: result };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    acme = await createTestTenant('SocketAcme');
    const [doc] = await db
      .insert(documents)
      .values({
        tenantId: acme.tenantId,
        title: 'Warranty',
        sourceType: 'text',
        source: 'warranty.md',
      })
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
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('streams an answer with sources over the socket', async () => {
    const socket = connect({ key, visitorId: 'visitor_socket_1' });
    await connected(socket);
    const { ack, deltas, done } = await ask(socket, 'How long is the frame warranty?');
    expect(ack.ok).toBe(true);
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join('')).toMatch(/lifetime warranty/i);
    expect(done!.sources[0]!.documentTitle).toBe('Warranty');
    expect(done!.conversationId).toBe(ack.ok ? ack.conversationId : '');
  });

  it('reloads the conversation history for the same visitor only', async () => {
    const socket = connect({ key, visitorId: 'visitor_socket_2' });
    await connected(socket);
    const first = await ask(socket, 'How long is the frame warranty?');
    const conversationId = first.done!.conversationId;

    const reloaded = connect({ key, visitorId: 'visitor_socket_2' });
    await connected(reloaded);
    const history = await reloaded.emitWithAck('conversation:history', { conversationId });
    expect(history.ok && history.messages.map((m) => m.sender)).toEqual(['customer', 'ai']);

    const stranger = connect({ key, visitorId: 'visitor_socket_9' });
    await connected(stranger);
    const denied = await stranger.emitWithAck('conversation:history', { conversationId });
    expect(denied).toMatchObject({ ok: false, code: 'conversation_not_found' });
    const hijack = await stranger.emitWithAck('message:send', { message: 'hi', conversationId });
    expect(hijack).toMatchObject({ ok: false, code: 'conversation_not_found' });
  });

  it('refuses a second message while an answer is still streaming', async () => {
    const socket = connect({ key, visitorId: 'visitor_socket_3' });
    await connected(socket);
    const [a, b] = await Promise.all([
      socket.emitWithAck('message:send', { message: 'How long is the frame warranty?' }),
      socket.emitWithAck('message:send', { message: 'And the battery?' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, code: 'busy' });
  });

  it('rejects invalid messages', async () => {
    const socket = connect({ key, visitorId: 'visitor_socket_4' });
    await connected(socket);
    expect(await socket.emitWithAck('message:send', { message: '   ' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('refuses the handshake for a bad key, a bad visitor id or a blocked website', async () => {
    expect(
      await refused(connect({ key: 'pk_test_unknown_key', visitorId: 'visitor_x_1' })),
    ).toMatch(/Unknown widget key/);
    expect(await refused(connect({ key, visitorId: 'x' }))).toMatch(/visitor id/);
    await db
      .update(tenants)
      .set({ allowedDomains: ['acme.example'] })
      .where(eq(tenants.id, acme.tenantId));
    try {
      expect(
        await refused(connect({ key, visitorId: 'visitor_x_2' }, 'https://evil.example')),
      ).toMatch(/not allowed/);
      await connected(connect({ key, visitorId: 'visitor_x_3' }, 'https://www.acme.example'));
    } finally {
      await db.update(tenants).set({ allowedDomains: [] }).where(eq(tenants.id, acme.tenantId));
    }
  });
});
