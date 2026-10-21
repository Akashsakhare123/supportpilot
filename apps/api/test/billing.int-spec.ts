import type { INestApplication } from '@nestjs/common';
import {
  and,
  createDb,
  createPool,
  type Database,
  documents,
  eq,
  messages,
  type Pool,
  stripeEvents,
  subscriptions,
  tenants,
  usageEvents,
} from '@supportpilot/db';
import type { BillingOverview, ChatDone } from '@supportpilot/shared';
import request from 'supertest';
import Stripe from 'stripe';
import { CHAT_TEXT } from '../src/chat/chat.service';
import {
  STRIPE_GATEWAY,
  type StripeGateway,
  type SubscriptionSnapshot,
} from '../src/billing/stripe.gateway';
import { createTestApp, createTestTenant, TEST_PASSWORD, type TestTenant } from './helpers';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const PRO = process.env.STRIPE_PRICE_PRO!;
const BUSINESS = process.env.STRIPE_PRICE_BUSINESS!;
const signer = new Stripe('sk_test_signer');

/** Stripe stand-in: records calls and serves subscriptions the test sets up. */
class FakeStripe implements StripeGateway {
  readonly configured = true;
  customers: { tenantId: string; email: string; id: string }[] = [];
  checkouts: { customerId: string; priceId: string; tenantId: string }[] = [];
  subs = new Map<string, SubscriptionSnapshot>();
  retrieved: string[] = [];

  async createCustomer(input: { tenantId: string; name: string; email: string }) {
    const id = `cus_${input.tenantId.slice(0, 8)}_${this.customers.length}`;
    this.customers.push({ ...input, id });
    return id;
  }
  async createCheckoutSession(input: { customerId: string; priceId: string; tenantId: string }) {
    this.checkouts.push(input);
    return `https://checkout.stripe.test/c/${this.checkouts.length}`;
  }
  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    return `https://billing.stripe.test/p/${input.customerId}`;
  }
  async retrieveSubscription(id: string) {
    this.retrieved.push(id);
    const sub = this.subs.get(id);
    if (!sub) throw new Error(`No such subscription: ${id}`);
    return { ...sub };
  }
  set(sub: Partial<SubscriptionSnapshot> & { id: string; customerId: string }) {
    this.subs.set(sub.id, {
      status: 'active',
      priceId: PRO,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      cancelAtPeriodEnd: false,
      tenantId: null,
      ...this.subs.get(sub.id),
      ...sub,
    });
  }
}

/** Stripe ids are unique in the database, so every run uses its own. */
const run = Date.now().toString(36);
const subShop1 = `sub_shop_1_${run}`;
const subOther1 = `sub_other_1_${run}`;
const subSneaky = `sub_sneaky_${run}`;
const subStranger = `sub_stranger_${run}`;
const subLimit1 = `sub_limit_1_${run}`;

let eventCounter = 0;
/** A Stripe event as the webhook receives it (id + type + data.object). */
function event(
  type: string,
  object: Record<string, unknown>,
  id = `evt_test_${++eventCounter}_${Date.now()}`,
) {
  return {
    id,
    object: 'event',
    type,
    api_version: '2026-09-30',
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

describe('Billing and plan limits (T13)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: Database;
  const fake = new FakeStripe();
  let shop: TestTenant;
  let other: TestTenant;
  let ownerToken: string;
  const http = () => request(app.getHttpServer());

  const login = async (email: string) =>
    (await http().post('/auth/login').send({ email, password: TEST_PASSWORD }).expect(200)).body
      .accessToken as string;
  const billing = async (token = ownerToken) =>
    (await http().get('/billing').set('Authorization', `Bearer ${token}`).expect(200))
      .body as BillingOverview;
  const planOf = async (tenantId: string) =>
    (await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }))!.plan;

  /** POST a signed event to the webhook, exactly like `stripe listen --forward-to` does. */
  function deliver(evt: object, secret = WEBHOOK_SECRET) {
    const payload = JSON.stringify(evt);
    const header = signer.webhooks.generateTestHeaderString({ payload, secret });
    return http()
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(payload);
  }

  /** Upgrade a tenant end to end: checkout (customer created) -> completed session webhook. */
  async function upgrade(tenant: TestTenant, token: string, subId: string, price = PRO) {
    await http()
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ plan: price === PRO ? 'pro' : 'business' })
      .expect(200);
    const customerId = (await db.query.tenants.findFirst({
      where: eq(tenants.id, tenant.tenantId),
    }))!.stripeCustomerId!;
    fake.set({ id: subId, customerId, priceId: price, tenantId: tenant.tenantId });
    const evt = event('checkout.session.completed', {
      id: `cs_${subId}`,
      object: 'checkout.session',
      mode: 'subscription',
      customer: customerId,
      subscription: subId,
      client_reference_id: tenant.tenantId,
    });
    await deliver(evt).expect(200);
    return { customerId, evt };
  }

  async function ask(key: string, message: string, visitorId: string): Promise<ChatDone> {
    const res = await http()
      .post('/v1/chat')
      .set('Origin', 'https://shop.example')
      .send({ key, visitorId, message })
      .buffer(true)
      .parse((res, callback) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => callback(null, body));
      })
      .expect(200);
    const block = (res.body as string).split('\n\n').find((b) => b.startsWith('event: done'));
    return JSON.parse(/^data: (.+)$/m.exec(block!)![1]!) as ChatDone;
  }

  async function fillAiAnswers(tenantId: string, count: number, at = new Date()) {
    await db
      .insert(usageEvents)
      .values(
        Array.from({ length: count }, () => ({ tenantId, type: 'chat.answer', createdAt: at })),
      );
  }

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(STRIPE_GATEWAY).useValue(fake));
    pool = createPool(process.env.DATABASE_URL!, { max: 2 });
    db = createDb(pool);
    shop = await createTestTenant('BillShop', 'free');
    other = await createTestTenant('BillOther', 'free');
    ownerToken = await login(shop.owner.email);
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('shows owners the Free plan, usage meters and plans; admins and agents get 403', async () => {
    const overview = await billing();
    expect(overview.plan).toBe('free');
    expect(overview.status).toBeNull();
    expect(overview.usage.aiAnswers).toEqual({ used: 0, limit: 100 });
    expect(overview.usage.documents).toEqual({ used: 0, limit: 5 });
    // The test tenant has an admin and an agent: 2 agents, over the Free limit of 1.
    expect(overview.usage.agents).toEqual({ used: 2, limit: 1 });
    expect(overview.configured).toBe(true);
    expect(overview.canManage).toBe(false);
    expect(overview.plans.map((p) => p.id)).toEqual(['free', 'pro', 'business']);
    for (const email of [shop.admin.email, shop.agent.email]) {
      const token = await login(email);
      await http().get('/billing').set('Authorization', `Bearer ${token}`).expect(403);
    }
    await http().get('/billing').expect(401);
  });

  it('creates one Stripe customer and a Checkout session for an upgrade', async () => {
    const res = await http()
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ plan: 'pro' })
      .expect(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const last = fake.checkouts.at(-1)!;
    expect(last).toMatchObject({ priceId: PRO, tenantId: shop.tenantId });
    expect(fake.customers.filter((c) => c.tenantId === shop.tenantId)).toHaveLength(1);
    expect(fake.customers.at(-1)!.email).toBe(shop.owner.email);

    // A second attempt reuses the customer; the client cannot pick a price or the free plan.
    await http()
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ plan: 'business' })
      .expect(200);
    expect(fake.customers.filter((c) => c.tenantId === shop.tenantId)).toHaveLength(1);
    expect(fake.checkouts.at(-1)!.customerId).toBe(last.customerId);
    for (const body of [{ plan: 'free' }, { plan: 'pro', price: 'price_cheap' }]) {
      await http()
        .post('/billing/checkout')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(body)
        .expect(400);
    }
    // Nothing changes until Stripe confirms through the webhook.
    expect(await planOf(shop.tenantId)).toBe('free');
  });

  it('refuses webhooks without a valid signature', async () => {
    const evt = event('customer.subscription.updated', {
      id: 'sub_forged',
      object: 'subscription',
    });
    await deliver(evt, 'whsec_wrong_secret').expect(400);
    await http()
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(evt))
      .expect(400);
    // A valid signature over a different body does not pass either.
    const header = signer.webhooks.generateTestHeaderString({
      payload: JSON.stringify(evt),
      secret: WEBHOOK_SECRET,
    });
    await http()
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(JSON.stringify({ ...evt, id: 'evt_tampered' }))
      .expect(400);
    expect(
      await db.query.stripeEvents.findFirst({ where: eq(stripeEvents.id, evt.id) }),
    ).toBeUndefined();
  });

  it('upgrades through checkout.session.completed, and a replayed event does not apply twice', async () => {
    const { evt } = await upgrade(shop, ownerToken, subShop1);
    expect(await planOf(shop.tenantId)).toBe('pro');
    const overview = await billing();
    expect(overview).toMatchObject({ plan: 'pro', status: 'active', canManage: true });
    expect(overview.usage.aiAnswers.limit).toBe(2_000);
    expect(overview.currentPeriodEnd).not.toBeNull();

    // Replay the same event after the subscription changed in Stripe: it is acknowledged and
    // ignored (no second fetch, no change), so old deliveries can never roll the plan back.
    const customerId = fake.subs.get(subShop1)!.customerId;
    fake.set({ id: subShop1, customerId, status: 'canceled' });
    const fetched = fake.retrieved.length;
    const replay = await deliver(evt).expect(200);
    expect(replay.body).toEqual({ received: true, duplicate: true });
    expect(fake.retrieved.length).toBe(fetched);
    expect(await planOf(shop.tenantId)).toBe('pro');
    const rows = await db.select().from(stripeEvents).where(eq(stripeEvents.id, evt.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(shop.tenantId);
    fake.set({ id: subShop1, customerId, status: 'active' });

    // With a live subscription, changes go through the Customer Portal.
    await http()
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ plan: 'business' })
      .expect(409);
    const portal = await http()
      .post('/billing/portal')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(portal.body.url).toContain('https://billing.stripe.test/p/cus_');
  });

  it('follows plan changes, failed payments and cancellation from Stripe', async () => {
    const customerId = fake.subs.get(subShop1)!.customerId;
    const sub = { id: subShop1, object: 'subscription' };

    fake.set({ id: subShop1, customerId, priceId: BUSINESS });
    await deliver(event('customer.subscription.updated', sub)).expect(200);
    expect(await planOf(shop.tenantId)).toBe('business');

    // Renewal failed: Stripe retries (past_due), the plan stays during the grace period.
    fake.set({ id: subShop1, customerId, status: 'past_due' });
    await deliver(
      event('invoice.payment_failed', {
        id: 'in_1',
        object: 'invoice',
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: subShop1 },
        },
      }),
    ).expect(200);
    let overview = await billing();
    expect(overview).toMatchObject({ plan: 'business', status: 'past_due', paymentFailed: true });

    // Paid again: the warning goes away.
    fake.set({ id: subShop1, customerId, status: 'active' });
    await deliver(event('customer.subscription.updated', sub)).expect(200);
    overview = await billing();
    expect(overview.paymentFailed).toBe(false);

    // Cancel at period end keeps the plan until Stripe ends the subscription.
    fake.set({ id: subShop1, customerId, cancelAtPeriodEnd: true });
    await deliver(event('customer.subscription.updated', sub)).expect(200);
    expect((await billing()).cancelAtPeriodEnd).toBe(true);
    expect(await planOf(shop.tenantId)).toBe('business');

    fake.set({ id: subShop1, customerId, status: 'canceled' });
    await deliver(event('customer.subscription.deleted', sub)).expect(200);
    expect(await planOf(shop.tenantId)).toBe('free');
    expect((await billing()).status).toBe('canceled');
  });

  it('never lets an event move a customer or plan to another tenant', async () => {
    const otherOwner = await login(other.owner.email);
    const { customerId: otherCustomer } = await upgrade(other, otherOwner, subOther1);
    expect(await planOf(other.tenantId)).toBe('pro');
    const shopCustomer = (await db.query.tenants.findFirst({
      where: eq(tenants.id, shop.tenantId),
    }))!.stripeCustomerId!;

    // A subscription of the other tenant's customer, claiming to be for "shop" in its metadata.
    fake.set({
      id: subSneaky,
      customerId: otherCustomer,
      priceId: BUSINESS,
      tenantId: shop.tenantId,
    });
    await deliver(
      event('checkout.session.completed', {
        id: 'cs_sneaky',
        object: 'checkout.session',
        mode: 'subscription',
        customer: otherCustomer,
        subscription: subSneaky,
        client_reference_id: shop.tenantId,
      }),
    ).expect(200);
    expect(await planOf(shop.tenantId)).toBe('free');
    expect(
      (await db.query.tenants.findFirst({ where: eq(tenants.id, shop.tenantId) }))!
        .stripeCustomerId,
    ).toBe(shopCustomer);

    // An unknown customer is acknowledged (so Stripe stops retrying) and changes nothing.
    fake.set({ id: subStranger, customerId: `cus_stranger_${run}` });
    await deliver(
      event('customer.subscription.updated', { id: subStranger, object: 'subscription' }),
    ).expect(200);
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subStranger));
    expect(rows).toHaveLength(0);
  });

  it('keeps the newer subscription when an older one ends later', async () => {
    const otherOwner = await login(other.owner.email);
    const customerId = fake.subs.get(subOther1)!.customerId;
    // other's newest subscription is sub_sneaky (business, active); the first one now ends.
    fake.set({ id: subOther1, customerId, status: 'canceled' });
    await deliver(
      event('customer.subscription.deleted', { id: subOther1, object: 'subscription' }),
    ).expect(200);
    const overview = (
      await http().get('/billing').set('Authorization', `Bearer ${otherOwner}`).expect(200)
    ).body as BillingOverview;
    expect(overview).toMatchObject({ plan: 'business', status: 'active' });
  });

  it('at the Free limit the widget gets no AI answer: the chat goes to the team', async () => {
    const free = await createTestTenant('BillLimit', 'free');
    const key = (await db.query.tenants.findFirst({ where: eq(tenants.id, free.tenantId) }))!
      .publicKey;
    // Last month's answers do not count.
    const lastMonth = new Date();
    lastMonth.setUTCDate(1);
    lastMonth.setUTCDate(0);
    await fillAiAnswers(free.tenantId, 150, lastMonth);
    const before = await ask(key, 'Do you sell skateboards?', 'visitor_limit_a');
    expect(before.content).not.toBe(CHAT_TEXT.limitOffline);

    await fillAiAnswers(free.tenantId, 100);
    const metered = async () =>
      (
        await db
          .select()
          .from(usageEvents)
          .where(and(eq(usageEvents.tenantId, free.tenantId), eq(usageEvents.type, 'chat.answer')))
      ).length;
    const count = await metered();
    const done = await ask(key, 'How long is the warranty?', 'visitor_limit_b');
    expect(done.content).toBe(CHAT_TEXT.limitOffline); // no agent online: leave an email
    expect(done.needsHuman).toBe(true);
    expect(done.conversationStatus).toBe('waiting');
    expect(await metered()).toBe(count);
    const stored = await db.query.messages.findFirst({
      where: and(eq(messages.conversationId, done.conversationId), eq(messages.sender, 'ai')),
    });
    expect(stored!.metadata).toMatchObject({ reason: 'plan_limit' });
    // The visitor is never told about the business's plan.
    expect(done.content).not.toMatch(/plan|limit|upgrade/i);

    // Another tenant at the same time is unaffected.
    const otherKey = (await db.query.tenants.findFirst({ where: eq(tenants.id, other.tenantId) }))!
      .publicKey;
    expect((await ask(otherKey, 'Hello there', 'visitor_limit_c')).content).not.toBe(
      CHAT_TEXT.limitOffline,
    );

    // After an upgrade (webhook) the AI answers again, even in a new conversation right away.
    await upgrade(free, await login(free.owner.email), subLimit1);
    const after = await ask(key, 'Do you sell skateboards?', 'visitor_limit_d');
    expect(after.content).not.toBe(CHAT_TEXT.limitOffline);
    expect(after.conversationStatus).toBe('ai');
  });

  it('refuses a 6th document and a 2nd agent on Free with 402 and a readable message', async () => {
    const free = await createTestTenant('BillDocs', 'free');
    const admin = await login(free.admin.email);
    await db.insert(documents).values(
      Array.from({ length: 5 }, (_, i) => ({
        tenantId: free.tenantId,
        title: `Doc ${i}`,
        sourceType: 'text' as const,
        source: `doc-${i}.md`,
        status: 'ready' as const,
      })),
    );
    const body = { title: 'One more', content: 'A sixth article that does not fit the Free plan.' };
    const refused = await http()
      .post('/documents/text')
      .set('Authorization', `Bearer ${admin}`)
      .send(body)
      .expect(402);
    expect(refused.body.message).toBe(
      'Your Free plan includes 5 documents. Upgrade on the Billing page.',
    );
    await http()
      .post('/documents/url')
      .set('Authorization', `Bearer ${admin}`)
      .send({ url: 'https://example.com/help' })
      .expect(402);
    const invite = await http()
      .post('/users/invites')
      .set('Authorization', `Bearer ${admin}`)
      .send({ email: `extra+${Date.now()}@example.test`, role: 'agent' })
      .expect(402);
    expect(invite.body.message).toBe(
      'Your Free plan includes 1 agent. Upgrade on the Billing page.',
    );

    // The same requests work on a paid plan.
    await db.update(tenants).set({ plan: 'pro' }).where(eq(tenants.id, free.tenantId));
    await http()
      .post('/documents/text')
      .set('Authorization', `Bearer ${admin}`)
      .send(body)
      .expect(201);
  });
});
