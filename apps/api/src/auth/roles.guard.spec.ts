import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@supportpilot/shared';
import { RolesGuard } from './roles.guard';

function contextFor(role: Role | undefined): ExecutionContext {
  const request = { auth: role ? { userId: 'u', tenantId: 't', role } : undefined };
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardRequiring(minRole: Role | undefined): RolesGuard {
  const reflector = { getAllAndOverride: () => minRole } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('allows routes without @Roles', () => {
    expect(guardRequiring(undefined).canActivate(contextFor('agent'))).toBe(true);
  });

  it('allows the required role and anything above it', () => {
    expect(guardRequiring('admin').canActivate(contextFor('admin'))).toBe(true);
    expect(guardRequiring('admin').canActivate(contextFor('owner'))).toBe(true);
  });

  it('rejects an agent on an admin-only route with 403', () => {
    expect(() => guardRequiring('admin').canActivate(contextFor('agent'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects when there is no authenticated user', () => {
    expect(() => guardRequiring('agent').canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
