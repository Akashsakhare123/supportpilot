import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { LimitKind } from '@supportpilot/shared';
import type { AuthedRequest } from '../auth/auth.types';
import { PlanLimitsService } from './plan-limits.service';

const PLAN_LIMIT_KEY = 'planLimit';

/**
 * Refuses the request with 402 when the caller's tenant is at its plan limit for `kind`, e.g.
 * `@PlanLimit('documents')` on uploads. Runs after the global auth guards (needs req.auth).
 */
@Injectable()
export class PlanLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: PlanLimitsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<LimitKind | undefined>(PLAN_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!kind || !auth) return true;
    await this.limits.assert(auth.tenantId, kind);
    return true;
  }
}

export const PlanLimit = (kind: LimitKind) =>
  applyDecorators(SetMetadata(PLAN_LIMIT_KEY, kind), UseGuards(PlanLimitGuard));
