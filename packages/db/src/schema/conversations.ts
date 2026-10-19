import type { ChatSource } from '@supportpilot/shared';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './users';

export const conversationStatus = pgEnum('conversation_status', [
  'ai',
  'waiting',
  'human',
  'closed',
]);
export const messageSender = pgEnum('message_sender', ['customer', 'ai', 'agent', 'system']);

/** One chat between a website visitor and the tenant (AI first, a human agent after handoff). */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Anonymous id the widget keeps per browser (or "playground:<userId>" for dashboard tests). */
    visitorId: text('visitor_id').notNull(),
    status: conversationStatus('status').notNull().default('ai'),
    assignedAgentId: uuid('assigned_agent_id').references(() => users.id, { onDelete: 'set null' }),
    /** Consecutive low-confidence AI answers; two in a row trigger a handoff (T10). */
    lowConfidenceStreak: integer('low_confidence_streak').notNull().default(0),
    /** Why it went to "waiting": customer_request | low_confidence (T10). */
    handoffReason: text('handoff_reason'),
    /** Left by the customer when no agent was online (offline ticket). */
    contactEmail: text('contact_email'),
    /** Origin (website) the conversation started on, for the agent inbox. */
    origin: text('origin'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversations_tenant_status_idx').on(t.tenantId, t.status, t.lastMessageAt),
    index('conversations_tenant_visitor_idx').on(t.tenantId, t.visitorId),
  ],
);

/** Every message, with the sources and confidence of AI answers (auditable). */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sender: messageSender('sender').notNull(),
    /** Agent who wrote it (sender = agent). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    sources: jsonb('sources').$type<ChatSource[]>().notNull().default([]),
    confidence: real('confidence'),
    needsHuman: boolean('needs_human').notNull().default(false),
    /** Model, latency, retrieval scores, PII kinds masked... (debugging and analytics). */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    index('messages_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

/** Metered events for analytics (T12) and plan limits (T13), e.g. one row per AI answer. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    quantity: integer('quantity').notNull().default(1),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_events_tenant_type_created_idx').on(t.tenantId, t.type, t.createdAt)],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
