import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  type Database,
  documents,
  eq,
  gt,
  gte,
  invites,
  isNull,
  lt,
  sql,
  tenants,
  usageEvents,
  users,
} from '@supportpilot/db';
import {
  atLimit,
  type LimitKind,
  limitMessage,
  type PlanId,
  PLANS,
  planOf,
  usagePeriod,
} from '@supportpilot/shared';
import { DRIZZLE } from '../database/database.module';

/** The usage event recorded for every AI answer (ChatService). */
export const AI_ANSWER_EVENT = 'chat.answer';

/** 402 Payment Required with a readable message and the limit that was hit. */
export class PlanLimitException extends HttpException {
  constructor(plan: PlanId, kind: LimitKind) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        code: 'plan_limit',
        limit: kind,
        message: limitMessage(plan, kind),
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export interface LimitCheck {
  plan: PlanId;
  kind: LimitKind;
  used: number;
  limit: number;
  allowed: boolean;
}

/**
 * Plan limits. The plan is read from the tenant row on every check (not from a cached tenant, so
 * an upgrade applies at once, even to open widget sockets), and usage from the database:
 * AI answers = this month's chat.answer usage events; documents and agents = current totals.
 */
@Injectable()
export class PlanLimitsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async planOf(tenantId: string): Promise<PlanId> {
    const row = await this.db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { plan: true },
    });
    return planOf(row?.plan);
  }

  async used(tenantId: string, kind: LimitKind, now = new Date()): Promise<number> {
    if (kind === 'aiAnswers') {
      const { start, end } = usagePeriod(now);
      const [row] = await this.db
        .select({ n: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int` })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.tenantId, tenantId),
            eq(usageEvents.type, AI_ANSWER_EVENT),
            gte(usageEvents.createdAt, start),
            lt(usageEvents.createdAt, end),
          ),
        );
      return Number(row?.n ?? 0);
    }
    if (kind === 'documents') {
      const [row] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.tenantId, tenantId));
      return Number(row?.n ?? 0);
    }
    // Agents: everyone but the owner, plus invites still waiting to be accepted.
    const [members] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), sql`${users.role} <> 'owner'`));
    const [pending] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(invites)
      .where(
        and(eq(invites.tenantId, tenantId), isNull(invites.acceptedAt), gt(invites.expiresAt, now)),
      );
    return Number(members?.n ?? 0) + Number(pending?.n ?? 0);
  }

  async check(tenantId: string, kind: LimitKind): Promise<LimitCheck> {
    const [plan, used] = await Promise.all([this.planOf(tenantId), this.used(tenantId, kind)]);
    const limit = PLANS[plan].limits[kind];
    return { plan, kind, used, limit, allowed: !atLimit(used, limit) };
  }

  /** Throw 402 when one more would go over the plan's limit. */
  async assert(tenantId: string, kind: LimitKind): Promise<void> {
    const result = await this.check(tenantId, kind);
    if (!result.allowed) throw new PlanLimitException(result.plan, kind);
  }
}
