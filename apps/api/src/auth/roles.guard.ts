import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Role, roleAtLeast } from '@supportpilot/shared';
import type { AuthedRequest } from './auth.types';
import { MIN_ROLE_KEY } from './decorators';

/** Global guard (runs after JwtAuthGuard): enforces @Roles(minRole) with owner > admin > agent. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const minRole = this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!minRole) return true;
    const { auth } = context.switchToHttp().getRequest<AuthedRequest>();
    if (!auth || !roleAtLeast(auth.role, minRole)) {
      throw new ForbiddenException(`Requires the ${minRole} role or higher`);
    }
    return true;
  }
}
