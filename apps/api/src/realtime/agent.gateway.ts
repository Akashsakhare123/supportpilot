import { Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { and, conversations, type Database, eq, users } from '@supportpilot/db';
import {
  AGENT_NAMESPACE,
  type AgentClientEvents,
  type AgentServerEvents,
  presenceSetSchema,
  type Role,
  typingSchema,
  WIDGET_LIMITS,
} from '@supportpilot/shared';
import type { Namespace, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/auth.types';
import { DRIZZLE } from '../database/database.module';
import { PresenceService } from './presence.service';
import { withinRate } from './rate-window';
import { RealtimeService, rooms } from './realtime.service';

interface AgentSocketData {
  userId: string;
  tenantId: string;
  role: Role;
  /** First name, shown to the customer as "Sam is typing". */
  name: string;
  presence: 'online' | 'away';
  /** Conversations already checked to belong to this tenant (typing events). */
  conversations: Set<string>;
  typing: number[];
}

type AgentNamespace = Namespace<
  AgentClientEvents,
  AgentServerEvents,
  Record<string, never>,
  AgentSocketData
>;
type AgentSocket = Socket<
  AgentClientEvents,
  AgentServerEvents,
  Record<string, never>,
  AgentSocketData
>;

/**
 * Live updates for dashboards. The handshake carries the access token
 * (`io(url, { auth: { token, presence } })`); every socket joins its tenant's room only, so
 * events never cross tenants. Commands (claim, reply, read) go over REST; the socket carries only
 * ephemeral signals: typing and presence heartbeats.
 */
@WebSocketGateway({
  namespace: AGENT_NAMESPACE,
  // The bearer token, not cookies or the origin, authenticates the socket.
  cors: { origin: true, credentials: false },
})
export class AgentGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AgentGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  afterInit(namespace: AgentNamespace): void {
    this.realtime.registerAgent(namespace);
    namespace.use((socket, next) => {
      const auth = socket.handshake.auth as { token?: unknown; presence?: unknown } | undefined;
      const token = auth?.token;
      if (typeof token !== 'string' || !token) return next(new Error('Missing access token'));
      this.jwt
        .verifyAsync<AccessTokenPayload>(token)
        .then(async (payload) => {
          const user = await this.db.query.users.findFirst({
            where: and(eq(users.id, payload.sub), eq(users.tenantId, payload.tid)),
            columns: { name: true },
          });
          if (!user) throw new Error('unknown user');
          const state = presenceSetSchema.safeParse({ state: auth?.presence });
          socket.data = {
            userId: payload.sub,
            tenantId: payload.tid,
            role: payload.role,
            name: user.name.split(' ')[0] || user.name,
            presence: state.success ? state.data.state : 'online',
            conversations: new Set(),
            typing: [],
          };
          // Before the connection completes, so "agents online" is right as soon as it connects.
          await this.presence.beat(payload.tid, payload.sub, socket.id, socket.data.presence);
          next();
        })
        .catch(() => next(new Error('Invalid or expired access token')));
    });
  }

  async handleConnection(socket: AgentSocket): Promise<void> {
    if (!socket.data?.tenantId) {
      socket.disconnect(true);
      return;
    }
    await socket.join(rooms.tenant(socket.data.tenantId));
    const agents = await this.presence.snapshot(socket.data.tenantId).catch(() => null);
    if (agents) socket.emit('presence:update', { agents });
    this.logger.debug(`agent ${socket.data.userId} connected`);
  }

  async handleDisconnect(socket: AgentSocket): Promise<void> {
    if (!socket.data?.tenantId) return;
    // Sockets also disconnect while the API shuts down, after Redis may be closed: the presence
    // key then expires by its TTL, so a failure here is harmless.
    await this.presence
      .leave(socket.data.tenantId, socket.data.userId, socket.id)
      .catch((error: unknown) => this.logger.debug(`presence leave skipped: ${String(error)}`));
  }

  /** Every PRESENCE.heartbeatMs from each open tab; refreshes the TTL. */
  @SubscribeMessage('presence:heartbeat')
  async heartbeat(@ConnectedSocket() socket: AgentSocket): Promise<void> {
    const d = socket.data;
    if (!d?.tenantId) return;
    await this.presence.beat(d.tenantId, d.userId, socket.id, d.presence);
  }

  /** The agent switched between online and away. */
  @SubscribeMessage('presence:set')
  async setPresence(
    @ConnectedSocket() socket: AgentSocket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const d = socket.data;
    const parsed = presenceSetSchema.safeParse(body);
    if (!d?.tenantId || !parsed.success) return;
    d.presence = parsed.data.state;
    await this.presence.beat(d.tenantId, d.userId, socket.id, d.presence);
  }

  /** The agent is typing a reply: shown in the customer's widget and to the rest of the team. */
  @SubscribeMessage('typing')
  async typing(@ConnectedSocket() socket: AgentSocket, @MessageBody() body: unknown) {
    const d = socket.data;
    const parsed = typingSchema.safeParse(body);
    if (!d?.tenantId || !parsed.success) return;
    if (!withinRate(d.typing, WIDGET_LIMITS.typingPer10s, 10_000)) return;
    const { conversationId, typing } = parsed.data;
    if (!d.conversations.has(conversationId)) {
      const row = await this.db.query.conversations.findFirst({
        where: and(eq(conversations.id, conversationId), eq(conversations.tenantId, d.tenantId)),
        columns: { id: true },
      });
      if (!row) return;
      if (d.conversations.size > 500) d.conversations.clear();
      d.conversations.add(conversationId);
    }
    this.realtime.visitorTyping(conversationId, typing, d.name);
    socket.to(rooms.tenant(d.tenantId)).emit('typing', {
      conversationId,
      typing,
      from: 'agent',
      userId: d.userId,
      name: d.name,
    });
  }
}
