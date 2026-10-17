import type { INestApplication } from '@nestjs/common';
import type { ApiEnv } from '@supportpilot/shared/node';
import cookieParser from 'cookie-parser';

/** Middleware and settings shared by main.ts and the integration tests. */
export function configureApp(app: INestApplication, env: ApiEnv): INestApplication {
  app.use(cookieParser());
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();
  return app;
}
