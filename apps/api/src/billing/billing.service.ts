import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  and,
  type Database,
  eq,
  isNull,
  stripeEvents,
  type SubscriptionRow,
  subscriptions,
  tenants,
  users,
} from '@supportpilot/db';
import {
  type BillingOverview,
  effectivePlan,
  ENTITLED_STATUSES,
  limitKinds,
  type PaidPlanId,
  type PlanId,
  planIds,
  PLANS,
  usagePeriod,
} from '@supportpilot/shared';
import type { ApiEnv } from '@supportpilot/shared/node';
import type Stripe from 'stripe';
import { ENV } from '../config/env';
import { DRIZZLE } from '../database/database.module';
import { PlanLimitsService } from './plan-limits.service';
import {
  STRIPE_GATEWAY,
  type StripeGateway,
  type SubscriptionSnapshot,
  verifyStripeEvent,
} from './stripe.gateway';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Events that change a subscription; everything else is acknowledged and ignored. */
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
] as const;

const entitled = (status: string | null | undefined) =>
  (ENTITLED_STATUSES as readonly string[]).includes(status ?? '');

/** What a verified event asks us to apply, fetched from Stripe before the transaction opens. */
interface PendingSync {
  snapshot: SubscriptionSnapshot;
  /** client_reference_id of a checkout session. */
  tenantHint: string | null;
  paymentFailed: boolean;
}

export interface WebhookResult {
  received: true;
  duplicate: boolean;
}

/**
 * Stripe billing. Checkout and the Customer Portal are the only ways to change a plan, and the
 * plan is only ever written here from verified webhook events: each event is re-read from
 * Stripe (latest state, so late or out-of-order deliveries cannot roll a plan back), then applied
 * in one transaction with its event id, which makes replays no-ops.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly priceToPlan: Map<string, PaidPlanId>;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
    private readonly limits: PlanLimitsService,
  ) {
    this.priceToPlan = new Map();
    if (env.STRIPE_PRICE_PRO) this.priceToPlan.set(env.STRIPE_PRICE_PRO, 'pro');
    if (env.STRIPE_PRICE_BUSINESS) this.priceToPlan.set(env.STRIPE_PRICE_BUSINESS, 'business');
  }

  private priceFor(plan: PaidPlanId): string | undefined {
    return plan === 'pro' ? this.env.STRIPE_PRICE_PRO : this.env.STRIPE_PRICE_BUSINESS;
  }

  /** Upgrades possible: secret key and both prices are set. */
  get configured(): boolean {
    return (
      this.stripe.configured && !!this.env.STRIPE_PRICE_PRO && !!this.env.STRIPE_PRICE_BUSINESS
    );
  }

  private async tenant(tenantId: string) {
    const row = await this.db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!row) throw new NotFoundException('Workspace not found');
    return row;
  }

  private subscriptionOf(tenantId: string): Promise<SubscriptionRow | undefined> {
    return this.db.query.subscriptions.findFirst({ where: eq(subscriptions.tenantId, tenantId) });
  }

  async overview(tenantId: string): Promise<BillingOverview> {
    const [tenant, subscription] = await Promise.all([
      this.tenant(tenantId),
      this.subscriptionOf(tenantId),
    ]);
    const plan = (planIds as readonly string[]).includes(tenant.plan)
      ? (tenant.plan as PlanId)
      : 'free';
    const used = await Promise.all(limitKinds.map((kind) => this.limits.used(tenantId, kind)));
    const period = usagePeriod();
    return {
      plan,
      status: subscription?.status ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      paymentFailed:
        !!subscription?.paymentFailedAt &&
        (subscription.status === 'past_due' || subscription.status === 'unpaid'),
      usage: Object.fromEntries(
        limitKinds.map((kind, i) => [kind, { used: used[i]!, limit: PLANS[plan].limits[kind] }]),
      ) as BillingOverview['usage'],
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      configured: this.configured,
      canManage: this.stripe.configured && !!tenant.stripeCustomerId,
      plans: planIds.map((id) => PLANS[id]),
    };
  }

  /** The tenant's Stripe customer, created once (the first checkout). */
  private async customerFor(tenantId: string, userId: string): Promise<string> {
    const tenant = await this.tenant(tenantId);
    if (tenant.stripeCustomerId) return tenant.stripeCustomerId;
    const owner = await this.db.query.users.findFirst({
      where: and(eq(users.id, userId), eq(users.tenantId, tenantId)),
      columns: { email: true },
    });
    const customerId = await this.stripe.createCustomer({
      tenantId,
      name: tenant.name,
      email: owner?.email ?? '',
    });
    // Only set it if nobody did meanwhile; then read back whichever won.
    await this.db
      .update(tenants)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), isNull(tenants.stripeCustomerId)));
    return (await this.tenant(tenantId)).stripeCustomerId ?? customerId;
  }

  /** Stripe Checkout URL for an upgrade. A tenant with a live subscription uses the portal. */
  async checkout(tenantId: string, userId: string, plan: PaidPlanId): Promise<string> {
    const price = this.priceFor(plan);
    if (!this.configured || !price) {
      throw new ServiceUnavailableException(
        'Billing is not set up on this server. Add the Stripe keys and prices to .env (see README).',
      );
    }
    const current = await this.subscriptionOf(tenantId);
    if (current && entitled(current.status)) {
      throw new ConflictException(
        'You already have a subscription. Use "Manage billing" to change or cancel it.',
      );
    }
    const customerId = await this.customerFor(tenantId, userId);
    return this.stripe.createCheckoutSession({
      customerId,
      priceId: price,
      tenantId,
      successUrl: `${this.env.APP_URL}/app/billing?checkout=success`,
      cancelUrl: `${this.env.APP_URL}/app/billing?checkout=cancelled`,
    });
  }

  /** Stripe Customer Portal URL: change plan, update the card, see invoices, cancel. */
  async portal(tenantId: string): Promise<string> {
    const tenant = await this.tenant(tenantId);
    if (!tenant.stripeCustomerId) {
      throw new ConflictException('There is no billing account yet. Upgrade first.');
    }
    return this.stripe.createPortalSession({
      customerId: tenant.stripeCustomerId,
      returnUrl: `${this.env.APP_URL}/app/billing`,
    });
  }

  /** POST /billing/webhook: verify, de-duplicate, fetch the latest state, apply. */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<WebhookResult> {
    const secret = this.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('STRIPE_WEBHOOK_SECRET is not set');
    if (!rawBody || !signature) throw new BadRequestException('Missing Stripe signature');
    let event: Stripe.Event;
    try {
      event = verifyStripeEvent(rawBody, signature, secret);
    } catch {
      throw new BadRequestException('Invalid Stripe signature');
    }

    const seen = await this.db.query.stripeEvents.findFirst({
      where: eq(stripeEvents.id, event.id),
      columns: { id: true },
    });
    if (seen) return { received: true, duplicate: true };

    // Network calls happen before the transaction; a Stripe outage -> 500 -> Stripe retries later.
    const pending = await this.pendingSync(event);
    const applied = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(stripeEvents)
        .values({ id: event.id, type: event.type })
        .onConflictDoNothing()
        .returning({ id: stripeEvents.id });
      if (inserted.length === 0) return false; // the same event is being handled in parallel
      if (pending) {
        const tenantId = await this.applySubscription(tx, pending);
        if (tenantId) {
          await tx.update(stripeEvents).set({ tenantId }).where(eq(stripeEvents.id, event.id));
        }
      }
      return true;
    });
    return { received: true, duplicate: !applied };
  }

  private async pendingSync(event: Stripe.Event): Promise<PendingSync | null> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.subscription) return null;
        const id =
          typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        return {
          snapshot: await this.stripe.retrieveSubscription(id),
          tenantHint: session.client_reference_id,
          paymentFailed: false,
        };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return {
          snapshot: await this.stripe.retrieveSubscription(event.data.object.id),
          tenantHint: null,
          paymentFailed: false,
        };
      case 'invoice.payment_failed': {
        const ref = event.data.object.parent?.subscription_details?.subscription;
        if (!ref) return null;
        return {
          snapshot: await this.stripe.retrieveSubscription(typeof ref === 'string' ? ref : ref.id),
          tenantHint: null,
          paymentFailed: true,
        };
      }
      default:
        return null;
    }
  }

  /**
   * Mirror a subscription and set the tenant's effective plan. The tenant is found by its Stripe
   * customer id; the tenant id from checkout / metadata is only used when no tenant has that
   * customer yet, and never moves a customer between tenants. Returns the tenant id, or null.
   */
  private async applySubscription(tx: Tx, pending: PendingSync): Promise<string | null> {
    const { snapshot } = pending;
    let tenant = await tx.query.tenants.findFirst({
      where: eq(tenants.stripeCustomerId, snapshot.customerId),
      columns: { id: true },
    });
    const hint = pending.tenantHint ?? snapshot.tenantId;
    if (!tenant && hint && /^[0-9a-f-]{36}$/i.test(hint)) {
      const [claimed] = await tx
        .update(tenants)
        .set({ stripeCustomerId: snapshot.customerId, updatedAt: new Date() })
        .where(and(eq(tenants.id, hint), isNull(tenants.stripeCustomerId)))
        .returning({ id: tenants.id });
      tenant = claimed;
    }
    if (!tenant) {
      this.logger.warn(`Stripe subscription ${snapshot.id}: no tenant for ${snapshot.customerId}`);
      return null;
    }

    const existing = await tx.query.subscriptions.findFirst({
      where: eq(subscriptions.tenantId, tenant.id),
    });
    // An older subscription ending must not cancel the newer one that replaced it.
    if (
      existing &&
      existing.stripeSubscriptionId !== snapshot.id &&
      entitled(existing.status) &&
      !entitled(snapshot.status)
    ) {
      return tenant.id;
    }

    const plan: PaidPlanId | undefined = snapshot.priceId
      ? this.priceToPlan.get(snapshot.priceId)
      : undefined;
    if (!plan) {
      this.logger.warn(`Stripe subscription ${snapshot.id}: unknown price ${snapshot.priceId}`);
    }
    const paidPlan: PlanId = plan ?? 'free';
    const paymentFailedAt = pending.paymentFailed
      ? new Date()
      : snapshot.status === 'active' || snapshot.status === 'trialing'
        ? null
        : (existing?.paymentFailedAt ?? null);
    const values = {
      stripeSubscriptionId: snapshot.id,
      stripeCustomerId: snapshot.customerId,
      stripePriceId: snapshot.priceId,
      plan: paidPlan,
      status: snapshot.status,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      paymentFailedAt,
      updatedAt: new Date(),
    };
    await tx
      .insert(subscriptions)
      .values({ tenantId: tenant.id, ...values })
      .onConflictDoUpdate({ target: subscriptions.tenantId, set: values });
    await tx
      .update(tenants)
      .set({ plan: effectivePlan(snapshot.status, paidPlan), updatedAt: new Date() })
      .where(eq(tenants.id, tenant.id));
    return tenant.id;
  }
}
