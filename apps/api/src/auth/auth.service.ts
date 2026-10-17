import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  and,
  type Database,
  eq,
  gt,
  invites,
  isNull,
  tenants,
  type User,
  users,
} from '@supportpilot/db';
import type {
  AcceptInviteInput,
  AuthUser,
  InvitePreview,
  LoginInput,
  Role,
} from '@supportpilot/shared';
import type { ApiEnv } from '@supportpilot/shared/node';
import { hashToken } from '../common/tokens';
import { ENV } from '../config/env';
import { DRIZZLE } from '../database/database.module';
import type { AccessTokenPayload } from './auth.types';
import { PasswordService } from './password.service';
import { type ClientMeta, RefreshTokenService } from './refresh-token.service';

export interface SessionResult {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /** Email + password login. Same error (and timing) for unknown email and wrong password. */
  async login(input: LoginInput, meta: ClientMeta): Promise<SessionResult> {
    // Login is the one lookup that is not tenant-scoped: the email identifies the tenant.
    const user = await this.db.query.users.findFirst({ where: eq(users.email, input.email) });
    const ok = await this.passwords.verify(user?.passwordHash ?? null, input.password);
    if (!user || !ok) throw new UnauthorizedException('Incorrect email or password');

    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return this.startSession(user, meta);
  }

  async refresh(token: string | undefined, meta: ClientMeta): Promise<SessionResult> {
    if (!token) throw new UnauthorizedException('No session');
    const rotated = await this.refreshTokens.rotate(token, meta);
    const user = await this.db.query.users.findFirst({ where: eq(users.id, rotated.userId) });
    if (!user) throw new UnauthorizedException('No session');
    return {
      ...(await this.accessFor(user)),
      refreshToken: rotated.token,
      refreshExpiresAt: rotated.expiresAt,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.refreshTokens.revoke(token);
  }

  async me(userId: string, tenantId: string): Promise<AuthUser> {
    const user = await this.db.query.users.findFirst({
      where: and(eq(users.id, userId), eq(users.tenantId, tenantId)),
    });
    if (!user) throw new UnauthorizedException();
    return this.toAuthUser(user);
  }

  /** Public: what an invite link is for, shown on the accept page. */
  async previewInvite(token: string): Promise<InvitePreview> {
    const invite = await this.findOpenInvite(token);
    const tenant = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, invite.tenantId),
    });
    return { email: invite.email, role: invite.role, tenantName: tenant?.name ?? '' };
  }

  /** Public: accept an invite, create the account in the inviting tenant, and sign in. */
  async acceptInvite(input: AcceptInviteInput, meta: ClientMeta): Promise<SessionResult> {
    const invite = await this.findOpenInvite(input.token);
    const taken = await this.db.query.users.findFirst({ where: eq(users.email, invite.email) });
    if (taken) throw new ConflictException('An account with this email already exists');

    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          tenantId: invite.tenantId,
          email: invite.email,
          name: input.name,
          role: invite.role,
          passwordHash,
          lastLoginAt: new Date(),
        })
        .returning();
      await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
      return created!;
    });
    return this.startSession(user, meta);
  }

  private async findOpenInvite(token: string) {
    const invite = await this.db.query.invites.findFirst({
      where: and(
        eq(invites.tokenHash, hashToken(token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    });
    if (!invite) throw new GoneException('This invite link is invalid, used or expired');
    return invite;
  }

  private async startSession(user: User, meta: ClientMeta): Promise<SessionResult> {
    const refresh = await this.refreshTokens.issue(user, meta);
    return {
      ...(await this.accessFor(user)),
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private async accessFor(
    user: User,
  ): Promise<{ accessToken: string; expiresIn: number; user: AuthUser }> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tid: user.tenantId,
      role: user.role as Role,
    };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
    });
    return {
      accessToken,
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
      user: await this.toAuthUser(user),
    };
  }

  /** Explicit mapping: the password hash can never leak into a response by accident. */
  private async toAuthUser(user: User): Promise<AuthUser> {
    const tenant = await this.db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
      tenant: { id: tenant.id, name: tenant.name },
    };
  }
}
