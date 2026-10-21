import { describe, expect, it } from 'vitest';
import {
  atLimit,
  checkoutSchema,
  effectivePlan,
  limitMessage,
  PLANS,
  planOf,
  usagePeriod,
} from './billing';

describe('plans', () => {
  it('Free has the limits from the plan: 100 AI answers, 5 documents, 1 agent', () => {
    expect(PLANS.free.limits).toEqual({ aiAnswers: 100, documents: 5, agents: 1 });
  });

  it('every paid plan allows more of everything than the plan below it', () => {
    for (const kind of ['aiAnswers', 'documents', 'agents'] as const) {
      expect(PLANS.pro.limits[kind]).toBeGreaterThan(PLANS.free.limits[kind]);
      expect(PLANS.business.limits[kind]).toBeGreaterThan(PLANS.pro.limits[kind]);
    }
  });
});

describe('planOf', () => {
  it('keeps known plans and falls back to free for anything else', () => {
    expect(planOf('pro')).toBe('pro');
    expect(planOf('business')).toBe('business');
    expect(planOf('enterprise')).toBe('free');
    expect(planOf('')).toBe('free');
    expect(planOf(null)).toBe('free');
  });
});

describe('effectivePlan', () => {
  it('grants the paid plan while active, trialing or past due', () => {
    expect(effectivePlan('active', 'pro')).toBe('pro');
    expect(effectivePlan('trialing', 'business')).toBe('business');
    expect(effectivePlan('past_due', 'pro')).toBe('pro');
  });

  it('drops to free when the subscription ended or never got paid', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(effectivePlan(status, 'pro')).toBe('free');
    }
    expect(effectivePlan(null, 'pro')).toBe('free');
  });
});

describe('usagePeriod', () => {
  it('is the calendar month in UTC', () => {
    const { start, end } = usagePeriod(new Date('2026-10-21T09:30:00Z'));
    expect(start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('rolls over the year in December', () => {
    const { start, end } = usagePeriod(new Date('2026-12-31T23:59:59Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('atLimit', () => {
  it('blocks the action that would go over the limit', () => {
    expect(atLimit(99, 100)).toBe(false);
    expect(atLimit(100, 100)).toBe(true);
    expect(atLimit(101, 100)).toBe(true);
  });
});

describe('limitMessage', () => {
  it('names the plan and the limit and points to the Billing page', () => {
    expect(limitMessage('free', 'documents')).toBe(
      'Your Free plan includes 5 documents. Upgrade on the Billing page.',
    );
    expect(limitMessage('business', 'aiAnswers')).toContain('10,000 AI answers a month');
    expect(limitMessage('free', 'agents')).toBe(
      'Your Free plan includes 1 agent. Upgrade on the Billing page.',
    );
  });
});

describe('checkoutSchema', () => {
  it('only accepts paid plans', () => {
    expect(checkoutSchema.parse({ plan: 'pro' })).toEqual({ plan: 'pro' });
    expect(() => checkoutSchema.parse({ plan: 'free' })).toThrow();
    expect(() => checkoutSchema.parse({ plan: 'pro', price: 'price_x' })).toThrow();
  });
});
