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
} from '@supportpilot/shared';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { InboxService } from './inbox.service';

/** Agent inbox (every team member). Live updates arrive on the /agent socket namespace. */
@Controller('conversations')
@Roles('agent')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

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

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationSummary> {
    return this.inbox.claim(auth.tenantId, auth.userId, id);
  }

  @Post(':id/messages')
  reply(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(agentReplySchema)) body: AgentReply,
  ): Promise<AgentMessage> {
    return this.inbox.reply(auth.tenantId, auth.userId, id, body.message);
  }
}
