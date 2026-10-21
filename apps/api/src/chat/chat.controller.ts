import { Body, Controller, Headers, Logger, Post, Res } from '@nestjs/common';
import { type ChatRequest, chatRequestSchema } from '@supportpilot/shared';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TENANT_CHAT_LIMIT } from '../security/rate-limits';
import { RateLimiter } from '../security/rate-limiter.service';
import { WidgetService } from '../widget/widget.service';
import { ChatService } from './chat.service';
import { SseStream } from './sse';

/**
 * Public chat API used by widget.js: POST /v1/chat streams the answer as Server-Sent Events
 * (meta -> delta... -> done). The widget key and the tenant's allowed domains decide access.
 */
@Public()
@Controller('v1/chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chat: ChatService,
    private readonly widget: WidgetService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post()
  async ask(
    @Body(new ZodValidationPipe(chatRequestSchema)) body: ChatRequest,
    @Headers('origin') origin: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Everything that can fail with a normal HTTP error happens before the stream opens.
    const tenant = await this.widget.resolveTenant(body.key, origin);
    // Per tenant across every visitor and API instance (T15); per address is the middleware's job.
    await this.limiter.assert(
      'tenant-chat',
      tenant.id,
      TENANT_CHAT_LIMIT.limit,
      TENANT_CHAT_LIMIT.windowMs,
    );
    const conversation = await this.chat.openConversation({
      tenant,
      visitorId: body.visitorId,
      conversationId: body.conversationId,
      message: body.message,
      origin,
    });
    await streamAnswer(this.chat, this.logger, res, () => ({
      tenant,
      conversation,
      message: body.message,
    }));
  }
}

/** Run one answer over SSE; errors after the headers are sent become an `error` event. */
export async function streamAnswer(
  chat: ChatService,
  logger: Logger,
  res: Response,
  input: () => {
    tenant: Parameters<ChatService['respond']>[0];
    conversation: Parameters<ChatService['respond']>[1];
    message: string;
  },
): Promise<void> {
  const sse = new SseStream(res);
  const { tenant, conversation, message } = input();
  try {
    const done = await chat.respond(
      tenant,
      conversation,
      message,
      {
        meta: (conversationId) => sse.send({ event: 'meta', data: { conversationId } }),
        delta: (text) => sse.send({ event: 'delta', data: { text } }),
      },
      sse.abort.signal,
    );
    sse.send({ event: 'done', data: done });
  } catch (error) {
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    sse.send({ event: 'error', data: { message: 'Something went wrong. Please try again.' } });
  } finally {
    sse.end();
  }
}
