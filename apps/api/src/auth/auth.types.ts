import type { Role } from '@supportpilot/shared';
import type { Request } from 'express';

/** Claims inside the access token. `tid` = tenant id. */
export interface AccessTokenPayload {
  sub: string;
  tid: string;
  role: Role;
}

/** Who is calling. Set by JwtAuthGuard from a verified token, never from the request body. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}
