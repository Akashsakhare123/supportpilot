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
  type HistoryMessage,
  WIDGET_LIMITS,
  WIDGET_NAMESPACE,
  type WidgetClientEvents,
  type WidgetErrorCode,
  type WidgetServerEvents,
  widgetAuthSchema,
  widgetHistorySchema,
  widgetSendSchema,
  offlineEmailSchema,
} from '@supportpilot/shared';
import type { Namespace, Socket } from 'socket.io';
import { HandoffService } from '../handoff/handoff.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WidgetService } from '../widget/widget.service';
import { ChatService } from './chat.service';

interface SocketState {
  tenant: Tenant;
  visitorId: string;
  origin?: string;
  busy: boolean;
  /** Timestamps of recent messages (sliding one-minute window). */
  sent: number[];
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
          socket.data = { tenant, visitorId: auth.data.visitorId, origin, busy: false, sent: [] };
          next();
        })
        .catch((error: unknown) => {
          next(new Error(error instanceof HttpException ? error.message : 'Connection refused'));
        });
    });
  }

  async handleConnection(socket: WidgetSocket): Promise<void> {
    // Room used by T09/T10 to reach this visitor (e.g. agent replies).
    if (socket.data?.tenant) {
      await socket.join(`tenant:${socket.data.tenant.id}:visitor:${socket.data.visitorId}`);
    }
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
    await socket.join(`conversation:${conversation.id}`);

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

  @SubscribeMessage('conversation:history')
  async history(
    @ConnectedSocket() socket: WidgetSocket,
    @MessageBody() body: unknown,
  ): Promise<ReturnType<typeof fail> | { ok: true; messages: HistoryMessage[] }> {
    const state = socket.data;
    if (!state?.tenant) return fail('invalid', 'Not connected');
    const parsed = widgetHistorySchema.safeParse(body);
    if (!parsed.success) return fail('invalid', 'Invalid conversation id');
    const messages = await this.chat.visitorHistory(
      state.tenant.id,
      state.visitorId,
      parsed.data.conversationId,
    );
    if (!messages) return fail('conversation_not_found', 'Conversation not found');
    await socket.join(`conversation:${parsed.data.conversationId}`);
    return { ok: true, messages };
  }
}
