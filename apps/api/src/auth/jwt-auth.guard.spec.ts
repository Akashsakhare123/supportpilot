import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthedRequest } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';

const jwt = new JwtService({ secret: 'unit-test-secret-unit-test-secret-123' });

function setup(isPublic: boolean, authorization?: string) {
  const request = { headers: { authorization } } as unknown as AuthedRequest;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
  return { guard: new JwtAuthGuard(reflector, jwt), context, request };
}

describe('JwtAuthGuard', () => {
  it('lets @Public routes through without a token', async () => {
    const { guard, context } = setup(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a missing token with 401', async () => {
    const { guard, context } = setup(false);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await new JwtService({
      secret: 'some-other-secret-some-other-secret',
    }).signAsync({
      sub: 'u1',
      tid: 't1',
      role: 'owner',
    });
    const { guard, context } = setup(false, `Bearer ${forged}`);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the tenant and role from a valid token', async () => {
    const token = await jwt.signAsync({ sub: 'u1', tid: 't1', role: 'agent' });
    const { guard, context, request } = setup(false, `Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.auth).toEqual({ userId: 'u1', tenantId: 't1', role: 'agent' });
  });
});
