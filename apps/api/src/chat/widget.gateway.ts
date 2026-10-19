import { HttpException, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Tenant } from '@supportpilot/db';
import {
  conversationReadSchema,
  offlineEmailSchema,
  typingSchema,
  WIDGET_LIMITS,
  WIDGET_NAMESPACE,
  type WidgetClientEvents,
  type WidgetErrorCode,
  type WidgetHistory,
  type WidgetServerEvents,
  widgetAuthSchema,
  widgetHistorySchema,
  widgetSendSchema,
} from '@supportpilot/shared';
import type { Namespace, Socket } from 'socket.io';
import { HandoffService } from '../handoff/handoff.service';
import { InboxService } from '../inbox/inbox.service';
import { PresenceService } from '../realtime/presence.service';
import { withinRate } from '../realtime/rate-window';
import { RealtimeService, rooms } from '../realtime/realtime.service';
import { WidgetService } from '../widget/widget.service';
import { ChatService } from './chat.service';

interface SocketState {
  tenant: Tenant;
  visitorId: string;
  origin?: string;
  busy: boolean;
  /** Timestamps of recent messages (sliding one-minute window). */
  sent: number[];
  /** Timestamps of recent typing events (flood protection). */
  typing: number[];
}

type WidgetSocket = Socket<
  WidgetClientEvents,
  WidgetServerEvents,
  Record<string, never>,
  SocketState
>;
type WidgetNamespace = Namespace<
  WidgetClientEvents,
  WidgetServerEvents,
  Record<string, never>,
  SocketState
>;

function fail(code: WidgetErrorCode, message: string) {
  return { ok: false as const, code, message };
}

/**
 * Live chat for widget.js. The handshake carries the public key and the anonymous visitor id;
 * the tenant's allowed domains are checked against the Origin header, exactly like the REST API.
 * Answers stream as message:delta events and finish with message:done (same ChatService as SSE).
 */
@WebSocketGateway({
  namespace: WIDGET_NAMESPACE,
  // Any website may connect; the per-tenant allowed-domains check below is the real gate.
  cors: { origin: true, credentials: false },
})
export class WidgetGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(WidgetGateway.name);

  constructor(
    private readonly chat: ChatService,
    private readonly widget: WidgetService,
    private readonly realtime: RealtimeService,
    private readonly handoff: HandoffService,
    private readonly inbox: InboxService,
    private readonly presence: PresenceService,
  ) {}

  /** Handshake check: the client gets connect_error with the reason if it is refused. */
  afterInit(namespace: WidgetNamespace): void {
    this.realtime.registerWidget(namespace);
    namespace.use((socket, next) => {
      const auth = widgetAuthSchema.safeParse(socket.handshake.auth);
      if (!auth.success) return next(new Error('Invalid widget key or visitor id'));
      const origin = socket.handshake.headers.origin;
      this.widget
        .resolveTenant(auth.data.key, origin)
        .then((tenant) => {
          socket.data = {
            tenant,
            visitorId: auth.data.visitorId,
            origin,
            busy: false,
            sent: [],
            typing: [],
          };
          next();
        })
        .catch((error: unknown) => {
          next(new Error(error instanceof HttpException ? error.message : 'Connection refused'));
        });
    });
  }

  async handleConnection(socket: WidgetSocket): Promise<void> {
    if (!socket.data?.tenant) return;
    const tenantId = socket.data.tenant.id;
    // Visitor room (reach this visitor) and the tenant's widget room (presence changes).
    await socket.join([
      `tenant:${tenantId}:visitor:${socket.data.visitorId}`,
      rooms.widgets(tenantId),
    ]);
    socket.emit('presence', { agentsOnline: (await this.presence.onlineCount(tenantId)) > 0 });
  }

  /** Only conversations this socket opened or loaded (both join the room after the owner check). */
  private owns(socket: WidgetSocket, conversationId: string): boolean {
    return socket.rooms.has(rooms.conversation(conversationId));
  }

  @SubscribeMessage('message:send')
  async send(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<ReturnType<typeof fail> | { ok: true; conversationId: string }> {
    const state = socket.data;
    if (!state?.tenant) return fail('invalid', 'Not connected');
    const parsed = widgetSendSchema.safeParse(body);
    if (!parsed.success) return fail('invalid', 'Type a message (up to 2000 characters)');
    if (state.busy) return fail('busy', 'Please wait for the current answer');
    const now = Date.now();
    state.sent = state.sent.filter((t) => now - t < 60_000);
    if (state.sent.length >= WIDGET_LIMITS.messagesPerMinute) {
      return fail('rate_limited', 'You are sending messages too quickly. Please wait a moment.');
    }
    state.sent.push(now);
    // Set before any await, so a second message sent in the same instant is refused.
    state.busy = true;

    let conversation: Awaited<ReturnType<ChatService['openConversation']>>;
    try {
      conversation = await this.chat.openConversation({
        tenant: state.tenant,
        visitorId: state.visitorId,
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
        origin: state.origin,
      });
    } catch (error) {
      state.busy = false;
      if (error instanceof HttpException && error.getStatus() === 404) {
        return fail('conversation_not_found', 'Conversation not found');
      }
      throw error;
    }
    await socket.join(rooms.conversation(conversation.id));

    // Answer in the background; the ack returns at once with the conversation id.
    const abort = new AbortController();
    const onDisconnect = () => abort.abort();
    socket.once('disconnect', onDisconnect);
    void this.chat
      .respond(
        state.tenant,
        conversation,
        parsed.data.message,
        {
          meta: () => undefined,
          delta: (text) => socket.emit('message:delta', { conversationId: conversation.id, text }),
        },
        abort.signal,
      )
      .then((done) => socket.emit('message:done', done))
      .catch((error: unknown) => {
        this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        socket.emit('message:error', {
          code: 'server_error',
          message: 'Something went wrong. Please try again.',
        });
      })
      .finally(() => {
        state.busy = false;
        socket.off('disconnect', onDisconnect);
      });
    return { ok: true, conversationId: conversation.id };
  }

  /** Offline ticket: the visitor leaves an email while no agent is online. */
  @SubscribeMessage('ticket:email')
  async ticketEmail(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<ReturnType<typeof fail> | { ok: true }> {
    const state = socket.data;
    if (!state?.tenant) return fail('invalid', 'Not connected');
    const parsed = offlineEmailSchema.safeParse(body);
    if (!parsed.success) {
      return fail('invalid', parsed.error.issues[0]?.message ?? 'Enter a valid email address');
    }
    const saved = await this.handoff.saveContactEmail(
      state.tenant.id,
      state.visitorId,
      parsed.data.conversationId,
      parsed.data.email,
    );
    return saved ? { ok: true } : fail('conversation_not_found', 'Conversation not found');
  }

  /**
   * Restore a conversation: the latest page after a reload, older pages (before), or the messages
   * missed while the connection was down (after). Joins the conversation room for live events.
   */
  @SubscribeMessage('conversation:history')
  async history(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<ReturnType<typeof fail> | ({ ok: true } & WidgetHistory)> {
    const state = socket.data;
    if (!state?.tenant) return fail('invalid', 'Not connected');
    const parsed = widgetHistorySchema.safeParse(body);
    if (!parsed.success) return fail('invalid', 'Invalid history request');
    const history = await this.chat.visitorHistory(state.tenant.id, state.visitorId, parsed.data);
    if (history === 'not_found') return fail('conversation_not_found', 'Conversation not found');
    if (history === 'unknown_cursor') return fail('invalid', 'Unknown message id');
    await socket.join(rooms.conversation(parsed.data.conversationId));
    return { ok: true, ...history };
  }

  /** The customer is typing: relayed to the tenant's agents (no ack, flood-limited). */
  @SubscribeMessage('typing')
  typing(@ConnectedSocket() socket: WidgetSocket, @MessageBody() body: unknown): void {
    const state = socket.data;
    const parsed = typingSchema.safeParse(body);
    if (!state?.tenant || !parsed.success || !this.owns(socket, parsed.data.conversationId)) return;
    if (!withinRate(state.typing, WIDGET_LIMITS.typingPer10s, 10_000)) return;
    this.realtime.customerTyping(state.tenant.id, parsed.data.conversationId, parsed.data.typing);
  }

  /** The visitor has the chat open and saw the latest messages (read receipt for agents). */
  @SubscribeMessage('conversation:read')
  async read(@ConnectedSocket() socket: WidgetSocket, @MessageBody() body: unknown): Promise<void> {
    const state = socket.data;
    const parsed = conversationReadSchema.safeParse(body);
    if (!state?.tenant || !parsed.success || !this.owns(socket, parsed.data.conversationId)) return;
    await this.inbox.markVisitorRead(state.tenant.id, state.visitorId, parsed.data.conversationId);
  }
}
