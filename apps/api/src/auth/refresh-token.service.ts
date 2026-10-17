import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { and, type Database, eq, isNull, refreshTokens, sql } from '@supportpilot/db';
import type { ApiEnv } from '@supportpilot/shared/node';
import { randomUUID } from 'node:crypto';
import { generateToken, hashToken } from '../common/tokens';
import { ENV } from '../config/env';
import { DRIZZLE } from '../database/database.module';

/** A refresh token presented again within this window counts as a concurrent refresh, not theft. */
export const REUSE_GRACE_MS = 10_000;

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  userId: string;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /** Issue a new token (a new family unless `familyId` is given). Only the hash is stored. */
  async issue(
    user: { id: string; tenantId: string },
    meta: ClientMeta,
    familyId: string = randomUUID(),
  ): Promise<IssuedRefreshToken> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await this.db.insert(refreshTokens).values({
      userId: user.id,
      tenantId: user.tenantId,
      tokenHash: hashToken(token),
      familyId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300),
      ip: meta.ip,
    });
    return { token, expiresAt };
  }

  /**
   * Rotate: revoke the presented token and issue its successor in the same family.
   * Reuse of an already-revoked token (outside REUSE_GRACE_MS) revokes the whole family.
   */
  async rotate(token: string, meta: ClientMeta): Promise<RotatedRefreshToken> {
    const tokenHash = hashToken(token);
    // Atomic claim: only one request can revoke a live token.
    const [claimed] = await this.db
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          isNull(refreshTokens.revokedAt),
          sql`${refreshTokens.expiresAt} > now()`,
        ),
      )
      .returning();

    if (claimed) {
      const next = await this.issue(
        { id: claimed.userId, tenantId: claimed.tenantId },
        meta,
        claimed.familyId,
      );
      return { ...next, userId: claimed.userId };
    }

    const existing = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
    });
    if (!existing || existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Session expired, please log in again');
    }
    const revokedAgo = Date.now() - (existing.revokedAt?.getTime() ?? 0);
    const familyActive = await this.db.query.refreshTokens.findFirst({
      where: and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)),
    });
    if (revokedAgo <= REUSE_GRACE_MS && familyActive) {
      // Two tabs refreshed at the same moment: hand this one its own successor.
      const next = await this.issue(
        { id: existing.userId, tenantId: existing.tenantId },
        meta,
        existing.familyId,
      );
      return { ...next, userId: existing.userId };
    }

    await this.revokeFamily(existing.familyId);
    this.logger.warn(`Refresh token reuse detected; revoked family ${existing.familyId}`);
    throw new UnauthorizedException('Session expired, please log in again');
  }

  /** Revoke the family of the presented token (logout). Unknown tokens are ignored. */
  async revoke(token: string): Promise<void> {
    const existing = await this.db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, hashToken(token)),
    });
    if (existing) await this.revokeFamily(existing.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }
}
