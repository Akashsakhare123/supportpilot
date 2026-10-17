import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  type InviteCreated,
  type InviteInput,
  inviteSchema,
  type TeamMember,
} from '@supportpilot/shared';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsersService } from './users.service';

@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Admins and owners see their team. Agents get 403. */
  @Get()
  list(@Auth() auth: AuthContext): Promise<TeamMember[]> {
    return this.users.list(auth.tenantId);
  }

  @Post('invites')
  invite(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(inviteSchema)) body: InviteInput,
  ): Promise<InviteCreated> {
    return this.users.invite(auth, body);
  }
}
