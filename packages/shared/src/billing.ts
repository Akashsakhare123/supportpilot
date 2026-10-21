import { z } from 'zod';

export const planIds = ['free', 'pro', 'business'] as const;
export type PlanId = (typeof planIds)[number];
export const paidPlanIds = ['pro', 'business'] as const;
export type PaidPlanId = (typeof paidPlanIds)[number];

/** What a plan meters. AI answers reset every calendar month (UTC); the others are totals. */
export const limitKinds = ['aiAnswers', 'documents', 'agents'] as const;
export type LimitKind = (typeof limitKinds)[number];
export type PlanLimits = Record<LimitKind, number>;

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month, shown on the Billing page (Stripe prices are the real amounts). */
  priceMonthly: number;
  limits: PlanLimits;
  features: string[];
}

/**
 * The plans. Limits live in code (reviewed, versioned); Stripe only says which plan a tenant pays
 * for. "agents" counts team members other than the owner, including pending invites.
 */
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    limits: { aiAnswers: 100, documents: 5, agents: 1 },
    features: ['100 AI answers a month', '5 knowledge-base documents', '1 agent'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 49,
    limits: { aiAnswers: 2_000, documents: 100, agents: 5 },
    features: ['2,000 AI answers a month', '100 documents', '5 agents', 'Analytics exports'],
  },
  business: {
    id: 'business',
    name: 'Business',
    priceMonthly: 199,
    limits: { aiAnswers: 10_000, documents: 1_000, agents: 25 },
    features: ['10,000 AI answers a month', '1,000 documents', '25 agents', 'Priority support'],
  },
};

export const LIMIT_LABELS: Record<LimitKind, { label: string; one: string; many: string }> = {
  aiAnswers: {
    label: 'AI answers this month',
    one: 'AI answer a month',
    many: 'AI answers a month',
  },
  documents: { label: 'Knowledge-base documents', one: 'document', many: 'documents' },
  agents: { label: 'Agents', one: 'agent', many: 'agents' },
};

/** Unknown or empty values (old rows, typos) fall back to Free: never grant more than paid for. */
export function planOf(value: string | null | undefined): PlanId {
  return (planIds as readonly string[]).includes(value ?? '') ? (value as PlanId) : 'free';
}

/** Stripe subscription statuses that keep the paid plan (past_due = grace while Stripe retries). */
export const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'] as const;

/** The plan a tenant gets from its subscription: the paid plan while entitled, otherwise Free. */
export function effectivePlan(status: string | null | undefined, paidPlan: PlanId): PlanId {
  return (ENTITLED_STATUSES as readonly string[]).includes(status ?? '') ? paidPlan : 'free';
}

/** The metering period for monthly limits: the calendar month (UTC) containing `now`. */
export function usagePeriod(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** True when one more unit would go over the limit. */
export function atLimit(used: number, limit: number): boolean {
  return used >= limit;
}

/** Message for a refused action (HTTP 402), shown as is in the dashboard. */
export function limitMessage(plan: PlanId, kind: LimitKind): string {
  const { name, limits } = PLANS[plan];
  const next = plan === 'business' ? 'Contact us to raise it' : 'Upgrade on the Billing page';
  const unit = limits[kind] === 1 ? LIMIT_LABELS[kind].one : LIMIT_LABELS[kind].many;
  return `Your ${name} plan includes ${limits[kind].toLocaleString('en-US')} ${unit}. ${next}.`;
}

/** POST /billing/checkout */
export const checkoutSchema = z.object({ plan: z.enum(paidPlanIds) }).strict();
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface UsageMeter {
  used: number;
  limit: number;
}

/** GET /billing (owners). */
export interface BillingOverview {
  plan: PlanId;
  /** Stripe subscription status (active, past_due, canceled...) or null on Free without one. */
  status: string | null;
  cancelAtPeriodEnd: boolean;
  /** ISO time the current paid period ends (renewal or cancellation date). */
  currentPeriodEnd: string | null;
  /** The last renewal failed and Stripe is retrying (status past_due / unpaid). */
  paymentFailed: boolean;
  usage: Record<LimitKind, UsageMeter>;
  /** Monthly AI-answer period (ISO). */
  period: { start: string; end: string };
  /** Stripe keys and prices are set, so upgrades are possible. */
  configured: boolean;
  /** A Stripe customer exists, so the Customer Portal can open. */
  canManage: boolean;
  plans: Plan[];
}

/** Body of POST /billing/checkout and /billing/portal responses: where to send the browser. */
export interface BillingRedirect {
  url: string;
}
