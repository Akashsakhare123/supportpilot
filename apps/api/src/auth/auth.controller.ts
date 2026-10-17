import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  type AcceptInviteInput,
  acceptInviteSchema,
  type AuthUser,
  type InvitePreview,
  type LoginInput,
  type LoginResponse,
  loginSchema,
  REFRESH_COOKIE,
  type SignupInput,
  signupSchema,
} from '@supportpilot/shared';
import type { ApiEnv } from '@supportpilot/shared/node';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ENV } from '../config/env';
import { AuthService, type SessionResult } from './auth.service';
import type { AuthContext } from './auth.types';
import { clearRefreshCookie, setRefreshCookie } from './cookies';
import { Auth, Public } from './decorators';
import type { ClientMeta } from './refresh-token.service';

function clientMeta(req: Request): ClientMeta {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    return this.respond(res, await this.auth.login(body, clientMeta(req)));
  }

  /** Self-serve signup: new tenant + owner, signed in straight away. */
  @Public()
  @Post('signup')
  async signup(
    @Body(new ZodValidationPipe(signupSchema)) body: SignupInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    return this.respond(res, await this.auth.signup(body, clientMeta(req)));
  }

  /** Uses the httpOnly refresh cookie; returns a new access token and rotates the cookie. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    try {
      return this.respond(res, await this.auth.refresh(readRefreshCookie(req), clientMeta(req)));
    } catch (error) {
      clearRefreshCookie(res, this.env);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.env);
  }

  @Get('me')
  me(@Auth() auth: AuthContext): Promise<AuthUser> {
    return this.auth.me(auth.userId, auth.tenantId);
  }

  @Public()
  @Get('invites/:token')
  previewInvite(@Param('token') token: string): Promise<InvitePreview> {
    return this.auth.previewInvite(token);
  }

  @Public()
  @Post('invites/accept')
  @HttpCode(HttpStatus.OK)
  async acceptInvite(
    @Body(new ZodValidationPipe(acceptInviteSchema)) body: AcceptInviteInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    return this.respond(res, await this.auth.acceptInvite(body, clientMeta(req)));
  }

  private respond(res: Response, session: SessionResult): LoginResponse {
    setRefreshCookie(res, this.env, session.refreshToken, session.refreshExpiresAt);
    return { accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user };
  }
}
