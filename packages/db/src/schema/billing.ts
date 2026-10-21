import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

/**
 * A tenant's Stripe subscription, mirrored from webhooks (Stripe is the source of truth; nothing
 * here is written from a client request). One row per tenant: a new subscription replaces it.
 */
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripePriceId: text('stripe_price_id'),
  /** Plan the price belongs to (pro | business); tenants.plan holds the effective plan. */
  plan: text('plan').notNull(),
  /** Stripe status: active, trialing, past_due, canceled, unpaid, incomplete... */
  status: text('status').notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  /** Set by invoice.payment_failed, cleared when the subscription is active again. */
  paymentFailedAt: timestamp('payment_failed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Stripe webhook events already applied, by event id. Stripe delivers at least once and may
 * retry or replay; inserting here in the same transaction as the change makes handling idempotent.
 */
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SubscriptionRow = typeof subscriptions.$inferSelect;
