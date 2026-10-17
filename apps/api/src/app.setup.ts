import type { INestApplication } from '@nestjs/common';
import type { ApiEnv } from '@supportpilot/shared/node';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';

/** Widget routes (/widget/*, public API /v1/*) are called by widget.js from client websites. */
export function isWidgetRoute(path: string): boolean {
  return path === '/widget' || path.startsWith('/widget/') || path.startsWith('/v1/');
}

/** Middleware and settings shared by main.ts and the integration tests. */
export function configureApp(app: INestApplication, env: ApiEnv): INestApplication {
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

  app.enableShutdownHooks();
  return app;
}
