import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { LimitKind } from '@supportpilot/shared';
import { PlanLimitGuard } from './plan-limit.guard';
import { PlanLimitException, type PlanLimitsService } from './plan-limits.service';

function contextFor(tenantId: string | undefined): ExecutionContext {
  const request = { auth: tenantId ? { userId: 'u', tenantId, role: 'admin' } : undefined };
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard(kind: LimitKind | undefined, atLimit: boolean) {
  const calls: [string, LimitKind][] = [];
  const limits = {
    assert: async (tenantId: string, k: LimitKind) => {
      calls.push([tenantId, k]);
      if (atLimit) throw new PlanLimitException('free', k);
    },
  } as unknown as PlanLimitsService;
  const reflector = { getAllAndOverride: () => kind } as unknown as Reflector;
  return { guard: new PlanLimitGuard(reflector, limits), calls };
}

describe('PlanLimitGuard', () => {
  it('lets routes without @PlanLimit through without counting anything', async () => {
    const { guard: g, calls } = guard(undefined, true);
    await expect(g.canActivate(contextFor('t1'))).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  it("checks the caller's own tenant (from the token) for the route's limit", async () => {
    const { guard: g, calls } = guard('documents', false);
    await expect(g.canActivate(contextFor('t1'))).resolves.toBe(true);
    expect(calls).toEqual([['t1', 'documents']]);
  });

  it('refuses with 402 and a readable message at the limit', async () => {
    const { guard: g } = guard('agents', true);
    const error = await g.canActivate(contextFor('t1')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanLimitException);
    expect((error as PlanLimitException).getStatus()).toBe(402);
    expect((error as PlanLimitException).message).toBe(
      'Your Free plan includes 1 agent. Upgrade on the Billing page.',
    );
  });

  it('leaves requests without a login to the auth guards', async () => {
    const { guard: g, calls } = guard('documents', true);
    await expect(g.canActivate(contextFor(undefined))).resolves.toBe(true);
    expect(calls).toEqual([]);
  });
});
