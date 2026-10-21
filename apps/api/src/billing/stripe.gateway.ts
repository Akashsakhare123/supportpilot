import { ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';

export const STRIPE_GATEWAY = Symbol('STRIPE_GATEWAY');

/** The parts of a Stripe subscription SupportPilot stores. */
export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** subscription_data.metadata.tenantId set at checkout (fallback when the customer is unknown). */
  tenantId: string | null;
}

/**
 * Everything the API asks Stripe. One small interface, so tests swap in a fake and never call
 * the network; webhook signatures are always checked with the real SDK (verifyStripeEvent).
 */
export interface StripeGateway {
  /** A secret key is set. */
  readonly configured: boolean;
  createCustomer(input: { tenantId: string; name: string; email: string }): Promise<string>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    tenantId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
  retrieveSubscription(id: string): Promise<SubscriptionSnapshot>;
}

export function toSnapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  const item = sub.items.data[0];
  return {
    id: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    status: sub.status,
    priceId: item?.price.id ?? null,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    tenantId: sub.metadata?.tenantId ?? null,
  };
}

/** The real gateway (Stripe SDK). Without STRIPE_SECRET_KEY every call is a clear 503. */
export class SdkStripeGateway implements StripeGateway {
  private readonly client: Stripe | null;

  constructor(secretKey: string | undefined) {
    this.client = secretKey
      ? new Stripe(secretKey, {
          maxNetworkRetries: 2,
          timeout: 15_000,
          appInfo: { name: 'SupportPilot' },
        })
      : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  private get stripe(): Stripe {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Billing is not set up on this server (STRIPE_SECRET_KEY is missing).',
      );
    }
    return this.client;
  }

  async createCustomer(input: { tenantId: string; name: string; email: string }): Promise<string> {
    const customer = await this.stripe.customers.create(
      { name: input.name, email: input.email, metadata: { tenantId: input.tenantId } },
      // Two clicks at once create one customer.
      { idempotencyKey: `customer-${input.tenantId}` },
    );
    return customer.id;
  }

  async createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    tenantId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      client_reference_id: input.tenantId,
      subscription_data: { metadata: { tenantId: input.tenantId } },
      allow_promotion_codes: true,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new ServiceUnavailableException('Stripe did not return a checkout URL');
    return session.url;
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return session.url;
  }

  async retrieveSubscription(id: string): Promise<SubscriptionSnapshot> {
    return toSnapshot(await this.stripe.subscriptions.retrieve(id));
  }
}

/** Only used for webhook signature checks, which need no API key or network. */
const verifier = new Stripe('sk_test_signature_check_only');

/**
 * Check the Stripe-Signature header (HMAC-SHA256 of the raw body, 5-minute tolerance against
 * replays of old deliveries) and parse the event. Throws when the signature does not match.
 */
export function verifyStripeEvent(
  rawBody: Buffer | string,
  signature: string,
  secret: string,
): Stripe.Event {
  return verifier.webhooks.constructEvent(rawBody, signature, secret);
}
