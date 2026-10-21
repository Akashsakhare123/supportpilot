import type { INestApplication } from '@nestjs/common';
import type { ApiEnv } from '@supportpilot/shared/node';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import type { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { RedisIoAdapter } from './realtime/redis-io.adapter';
import { HTTP_RULES, isExempt } from './security/rate-limits';
import { RateLimiter, TOO_MANY } from './security/rate-limiter.service';

/** Widget routes (/widget/*, public API /v1/*) are called by widget.js from client websites. */
export function isWidgetRoute(path: string): boolean {
  return path === '/widget' || path.startsWith('/widget/') || path.startsWith('/v1/');
}

/** Middleware and settings shared by main.ts and the integration tests. */
export function configureApp(app: INestApplication, env: ApiEnv): INestApplication {
  // Client IP for rate limits: X-Forwarded-For is only trusted from the configured proxies.
  const trust = /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY;
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', trust);
  // Security headers (T15). The API only serves JSON, so the strictest defaults apply.
  app.use(helmet());
  app.use(cookieParser());

  // CORS per route: widget endpoints accept any website (no cookies; the per-tenant allowed-domains
  // check in WidgetService is the real gate). Everything else only the dashboard origins, with cookies.
  const widgetCors = cors({
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  });
  const dashboardCors = cors({ origin: env.CORS_ORIGINS, credentials: true });
  app.use((req: Request, res: Response, next: NextFunction) =>
    (isWidgetRoute(req.path) ? widgetCors : dashboardCors)(req, res, next),
  );

  // Rate limits per client address (T15), after CORS so a 429 is readable by the widget.
  const limiter = app.get(RateLimiter);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isExempt(req.method, req.path)) return next();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    void (async () => {
      for (const rule of HTTP_RULES) {
        if (!rule.matches(req.method, req.path)) continue;
        const result = await limiter.consume(rule.name, ip, rule.limit, rule.windowMs);
        if (!result.allowed) {
          res
            .status(429)
            .set('Retry-After', String(result.retryAfter))
            .json({ statusCode: 429, error: 'Too Many Requests', message: TOO_MANY });
          return;
        }
      }
      next();
    })().catch(next);
  });

  // Socket.io across API instances (widget + agent namespaces) through Redis.
  app.useWebSocketAdapter(new RedisIoAdapter(app, env.REDIS_URL));
  app.enableShutdownHooks();
  return app;
}
