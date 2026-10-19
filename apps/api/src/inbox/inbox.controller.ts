import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  type AgentMessage,
  type AgentReply,
  agentReplySchema,
  type ConversationDetail,
  type ConversationSummary,
  type InboxList,
  type InboxTab,
  inboxTabs,
  type MessagePage,
  type MessagePageQuery,
  messagePageQuerySchema,
} from '@supportpilot/shared';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { HandoffService } from '../handoff/handoff.service';
import { InboxService } from './inbox.service';

/** Agent inbox (every team member). Live updates arrive on the /agent socket namespace. */
@Controller('conversations')
@Roles('agent')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly handoff: HandoffService,
  ) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query('tab') tab = 'needs_agent'): Promise<InboxList> {
    if (!inboxTabs.includes(tab as InboxTab)) {
      throw new BadRequestException(`tab must be one of: ${inboxTabs.join(', ')}`);
    }
    return this.inbox.list(auth.tenantId, auth.userId, tab as InboxTab);
  }

  @Get(':id')
  detail(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDetail> {
    return this.inbox.detail(auth.tenantId, id);
  }

  /** Older messages (?before=<messageId>) or missed ones after a reconnect (?after=<messageId>). */
  @Get(':id/messages')
  messages(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(messagePageQuerySchema)) query: MessagePageQuery,
  ): Promise<MessagePage<AgentMessage>> {
    return this.inbox.messagePage(auth.tenantId, id, query);
  }

  /** The agent has seen the conversation: clears unread, sends a read receipt to the widget. */
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  read(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationSummary> {
    return this.inbox.markAgentRead(auth.tenantId, id);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationSummary> {
    return this.handoff.claim(auth.tenantId, auth.userId, id);
  }

  @Post(':id/messages')
  reply(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(agentReplySchema)) body: AgentReply,
  ): Promise<AgentMessage> {
    return this.handoff.reply(auth.tenantId, auth.userId, id, body.message);
  }

  /** Give the conversation back to the AI assistant. */
  @Post(':id/hand-back')
  @HttpCode(HttpStatus.OK)
  handBack(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationSummary> {
    return this.handoff.handBack(auth.tenantId, auth.userId, id);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationSummary> {
    return this.handoff.close(auth.tenantId, auth.userId, id);
  }
}
