import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type AgentClientEvents,
  type AgentMessage,
  type AgentServerEvents,
  CHANNELS,
  type ConversationStatus,
  type ConversationSummary,
  type DocumentStatusEvent,
  type HistoryMessage,
  type WidgetClientEvents,
  type WidgetServerEvents,
} from '@supportpilot/shared';
import { type ApiEnv, redisOptionsFromUrl } from '@supportpilot/shared/node';
import { Redis } from 'ioredis';
import type { Namespace } from 'socket.io';
import { ENV } from '../config/env';

type WidgetNamespace = Namespace<WidgetClientEvents, WidgetServerEvents>;
type AgentNamespace = Namespace<AgentClientEvents, AgentServerEvents>;

export const rooms = {
  tenant: (tenantId: string) => `tenant:${tenantId}`,
  conversation: (conversationId: string) => `conversation:${conversationId}`,
};

/**
 * One place that pushes live events. Gateways register their namespaces; services call these
 * methods after they change data. With the Redis adapter, emits reach sockets on every API
 * instance.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private widget: WidgetNamespace | null = null;
  private agent: AgentNamespace | null = null;
  private subscriber: Redis | null = null;

  constructor(@Inject(ENV) private readonly env: ApiEnv) {}

  /** Called by the gateways once their namespace exists (typed loosely: socket data differs). */
  registerWidget(namespace: object): void {
    this.widget = namespace as WidgetNamespace;
  }

  registerAgent(namespace: object): void {
    this.agent = namespace as AgentNamespace;
  }

  /** Relay the worker's document status events to the tenant's dashboards. */
  async onModuleInit(): Promise<void> {
    this.subscriber = new Redis(redisOptionsFromUrl(this.env.REDIS_URL));
    this.subscriber.on('error', (error) => this.logger.warn(`Redis subscriber: ${error.message}`));
    this.subscriber.on('message', (_channel, raw) => {
      try {
        const event = JSON.parse(raw) as DocumentStatusEvent;
        // Every instance receives the pub/sub message, so emit to local sockets only.
        this.agent?.local.to(rooms.tenant(event.tenantId)).emit('document:status', {
          documentId: event.documentId,
          status: event.status,
          error: event.error,
          chunkCount: event.chunkCount,
        });
      } catch {
        // Ignore malformed messages.
      }
    });
    await this.subscriber.subscribe(CHANNELS.documentStatus).catch((error: Error) => {
      this.logger.warn(`Could not subscribe to document status events: ${error.message}`);
    });
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
    this.subscriber = null;
  }

  conversationChanged(tenantId: string, summary: ConversationSummary): void {
    this.agent?.to(rooms.tenant(tenantId)).emit('conversation:upsert', summary);
  }

  agentMessage(tenantId: string, conversationId: string, message: AgentMessage): void {
    this.agent?.to(rooms.tenant(tenantId)).emit('message:new', { conversationId, message });
  }

  /** A message the visitor's widget did not produce itself (agent reply, notices). */
  visitorMessage(conversationId: string, message: HistoryMessage): void {
    this.widget
      ?.to(rooms.conversation(conversationId))
      .emit('message:new', { conversationId, message });
  }

  visitorStatus(
    conversationId: string,
    status: ConversationStatus,
    agentName: string | null,
    agentsOnline?: boolean,
  ): void {
    this.widget
      ?.to(rooms.conversation(conversationId))
      .emit('conversation:status', { conversationId, status, agentName, agentsOnline });
  }

  /** Dashboards connected for this tenant, on every API instance (Redis adapter). */
  async agentsOnline(tenantId: string): Promise<number> {
    if (!this.agent) return 0;
    try {
      return (await this.agent.in(rooms.tenant(tenantId)).fetchSockets()).length;
    } catch (error) {
      this.logger.warn(`Could not count online agents: ${(error as Error).message}`);
      return 0;
    }
  }
}
