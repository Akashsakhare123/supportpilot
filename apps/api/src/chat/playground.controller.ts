import { Body, Controller, Inject, Logger, NotFoundException, Post, Res } from '@nestjs/common';
import { type Database, eq, tenants } from '@supportpilot/db';
import { type PlaygroundChatRequest, playgroundChatSchema } from '@supportpilot/shared';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DRIZZLE } from '../database/database.module';
import { streamAnswer } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * Dashboard "Test your assistant": the same pipeline as the widget, for signed-in team members,
 * without a widget key or allowed-domain check. Conversations are tagged playground:<userId>.
 */
@Controller('chat/playground')
@Roles('agent')
export class PlaygroundController {
  private readonly logger = new Logger(PlaygroundController.name);

  constructor(
    private readonly chat: ChatService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  @Post()
  async ask(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(playgroundChatSchema)) body: PlaygroundChatRequest,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = await this.db.query.tenants.findFirst({ where: eq(tenants.id, auth.tenantId) });
    if (!tenant) throw new NotFoundException('Workspace not found');
    const conversation = await this.chat.openConversation({
      tenant,
      visitorId: `playground:${auth.userId}`,
      conversationId: body.conversationId,
      message: body.message,
      origin: 'dashboard-playground',
    });
    await streamAnswer(this.chat, this.logger, res, () => ({
      tenant,
      conversation,
      message: body.message,
    }));
  }
}
