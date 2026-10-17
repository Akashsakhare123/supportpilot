import type { TenantBranding } from '@supportpilot/shared';
import { jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** One row per client business. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),
  /** Identifies the tenant to the widget (pk_live_...). Safe to expose, rotatable. */
  publicKey: text('public_key').notNull().unique(),
  branding: jsonb('branding').$type<TenantBranding>().notNull().default({}),
  /** Domains allowed to embed the widget (checked against the Origin header). */
  allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
  handoffThreshold: real('handoff_threshold').notNull().default(0.55),
  /** Set when an owner/admin finishes the onboarding wizard. */
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
