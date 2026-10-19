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
  type AgentPresence,
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
  /** Every widget socket of a tenant (presence: "is anyone on the team online?"). */
  widgets: (tenantId: string) => `widgets:${tenantId}`,
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

  /** An agent is typing: shown in the visitor's widget. */
  visitorTyping(conversationId: string, typing: boolean, name: string | null): void {
    this.widget?.to(rooms.conversation(conversationId)).emit('typing', {
      conversationId,
      typing,
      name,
    });
  }

  /** The customer is typing: shown to the tenant's agents. */
  customerTyping(tenantId: string, conversationId: string, typing: boolean): void {
    this.agent?.to(rooms.tenant(tenantId)).emit('typing', {
      conversationId,
      typing,
      from: 'customer',
      userId: null,
      name: null,
    });
  }

  /** An agent read the conversation: "Seen" under the customer's messages in the widget. */
  visitorReadReceipt(conversationId: string, readAt: string): void {
    this.widget?.to(rooms.conversation(conversationId)).emit('conversation:read', {
      conversationId,
      readAt,
    });
  }

  presenceChanged(tenantId: string, agents: AgentPresence[]): void {
    this.agent?.to(rooms.tenant(tenantId)).emit('presence:update', { agents });
  }

  /** "Is anyone on the team online?" changed: tell every open widget of the tenant. */
  widgetPresence(tenantId: string, agentsOnline: boolean): void {
    this.widget?.to(rooms.widgets(tenantId)).emit('presence', { agentsOnline });
  }
}
