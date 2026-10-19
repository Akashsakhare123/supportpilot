import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import {
  AGENT_NAMESPACE,
  type AgentClientEvents,
  type AgentServerEvents,
  type Role,
} from '@supportpilot/shared';
import type { Namespace, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/auth.types';
import { RealtimeService, rooms } from './realtime.service';

interface AgentSocketData {
  userId: string;
  tenantId: string;
  role: Role;
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
 * (`io(url, { auth: { token } })`); every socket joins its tenant's room only, so events never
 * cross tenants. Commands (claim, reply) go over REST.
 */
@WebSocketGateway({
  namespace: AGENT_NAMESPACE,
  // The bearer token, not cookies or the origin, authenticates the socket.
  cors: { origin: true, credentials: false },
})
export class AgentGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(AgentGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(namespace: AgentNamespace): void {
    this.realtime.registerAgent(namespace);
    namespace.use((socket, next) => {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || !token) return next(new Error('Missing access token'));
      this.jwt
        .verifyAsync<AccessTokenPayload>(token)
        .then((payload) => {
          socket.data = { userId: payload.sub, tenantId: payload.tid, role: payload.role };
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
    this.logger.debug(`agent ${socket.data.userId} connected`);
  }
}
