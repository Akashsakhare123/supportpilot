import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, type Database, eq, gt, invites, isNull, users } from '@supportpilot/db';
import {
  type InviteCreated,
  type InviteInput,
  invitableRoles,
  type Role,
  type TeamMember,
} from '@supportpilot/shared';
import type { ApiEnv } from '@supportpilot/shared/node';
import type { AuthContext } from '../auth/auth.types';
import { generateToken, hashToken } from '../common/tokens';
import { ENV } from '../config/env';
import { DRIZZLE } from '../database/database.module';

const INVITE_TTL_MS = 7 * 86_400_000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /** Team members of the caller's tenant (tenant id comes from the token). */
  async list(tenantId: string): Promise<TeamMember[]> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(asc(users.createdAt));
    return rows.map((row) => ({
      ...row,
      role: row.role as Role,
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    }));
  }

  /** Create an invite link. Owners can invite admins and agents; admins can invite agents. */
  async invite(caller: AuthContext, input: InviteInput): Promise<InviteCreated> {
    if (!invitableRoles(caller.role).includes(input.role)) {
      throw new ForbiddenException(`A ${caller.role} cannot invite a ${input.role}`);
    }
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, input.email) });
    if (existing) throw new ConflictException('A user with this email already exists');

    const pending = await this.db.query.invites.findFirst({
      where: and(
        eq(invites.tenantId, caller.tenantId),
        eq(invites.email, input.email),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    });
    if (pending) throw new ConflictException('This email already has a pending invite');

    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const [invite] = await this.db
      .insert(invites)
      .values({
        tenantId: caller.tenantId,
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: caller.userId,
        expiresAt,
      })
      .returning();

    const inviteUrl = `${this.env.APP_URL}/invite/${token}`;
    const result: InviteCreated = {
      id: invite!.id,
      email: invite!.email,
      role: invite!.role as Role,
      expiresAt: expiresAt.toISOString(),
    };
    if (this.env.NODE_ENV !== 'production') {
      // No email provider yet: in development the link is printed and returned instead.
      this.logger.log(`Invite for ${input.email} (${input.role}): ${inviteUrl}`);
      result.inviteUrl = inviteUrl;
    }
    return result;
  }
}
