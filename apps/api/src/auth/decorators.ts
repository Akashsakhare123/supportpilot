import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { Role } from '@supportpilot/shared';
import type { AuthContext, AuthedRequest } from './auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const MIN_ROLE_KEY = 'minRole';

/** Route needs no access token (login, refresh, health, widget config...). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route needs at least this role: @Roles('admin') allows admins and owners. */
export const Roles = (minRole: Role) => SetMetadata(MIN_ROLE_KEY, minRole);

/** Injects the verified caller ({ userId, tenantId, role }) into a handler parameter. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const request = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!request.auth) throw new UnauthorizedException();
  return request.auth;
});
