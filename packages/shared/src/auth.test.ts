import { describe, expect, it } from 'vitest';
import { acceptInviteSchema, invitableRoles, loginSchema, roleAtLeast } from './auth';

describe('roleAtLeast', () => {
  it('ranks owner > admin > agent', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('agent', 'admin')).toBe(false);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
  });
});

describe('invitableRoles', () => {
  it('only lets users invite roles below their own (owner may invite admins)', () => {
    expect(invitableRoles('owner')).toEqual(['admin', 'agent']);
    expect(invitableRoles('admin')).toEqual(['agent']);
    expect(invitableRoles('agent')).toEqual([]);
  });
});

describe('auth schemas', () => {
  it('normalises email case and whitespace', () => {
    const parsed = loginSchema.parse({ email: '  Owner@Acme.TEST ', password: 'x' });
    expect(parsed.email).toBe('owner@acme.test');
  });

  it('enforces a minimum password length on invite acceptance', () => {
    const result = acceptInviteSchema.safeParse({
      token: 'a'.repeat(43),
      name: 'Sam',
      password: 'short',
    });
    expect(result.success).toBe(false);
  });
});
