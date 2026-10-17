import { z } from 'zod';

/** Dashboard roles, highest first. Each role can do everything the roles below it can. */
export const ROLES = ['owner', 'admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, agent: 1 };

/** True when `role` is `min` or higher (owner > admin > agent). */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Roles a user may invite: owners invite admins and agents, admins invite agents. */
export function invitableRoles(role: Role): Role[] {
  if (role === 'owner') return ['admin', 'agent'];
  if (role === 'admin') return ['agent'];
  return [];
}

/** Name of the httpOnly cookie that holds the rotating refresh token. */
export const REFRESH_COOKIE = 'sp_refresh';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const inviteSchema = z.object({
  email,
  role: z.enum(['admin', 'agent']),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const signupSchema = z.object({
  companyName: z.string().trim().min(2, 'Company name is too short').max(80),
  name: z.string().trim().min(1, 'Name is required').max(100),
  email,
  password,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

/** The signed-in user as the API returns it (never includes the password hash). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** `onboarded` is false until an owner/admin finishes the onboarding wizard. */
  tenant: { id: string; name: string; onboarded: boolean };
}

export interface LoginResponse {
  accessToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  user: AuthUser;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface InviteCreated {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  /** Only returned outside production, where invite emails are printed to the API log instead of sent. */
  inviteUrl?: string;
}

export interface InvitePreview {
  email: string;
  role: Role;
  tenantName: string;
}
