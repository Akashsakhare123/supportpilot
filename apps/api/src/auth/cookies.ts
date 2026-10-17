import { REFRESH_COOKIE } from '@supportpilot/shared';
import type { ApiEnv } from '@supportpilot/shared/node';
import type { CookieOptions, Response } from 'express';

function cookieOptions(env: ApiEnv): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    // The dashboard proxies /api/* to the API, so the cookie is first-party: Lax is enough.
    sameSite: 'lax',
    path: '/',
  };
}

export function setRefreshCookie(res: Response, env: ApiEnv, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(env), expires: expiresAt });
}

export function clearRefreshCookie(res: Response, env: ApiEnv): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(env));
}
