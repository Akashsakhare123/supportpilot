import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { initMonitoring, SentryExceptionFilter } from './common/monitoring';
import { RedactingLogger } from './common/redacting-logger';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const monitored = initMonitoring('api');
  const app = configureApp(
    await NestFactory.create(AppModule, { rawBody: true, logger: new RedactingLogger() }),
    env,
  );
  if (monitored)
    app.useGlobalFilters(new SentryExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(env.API_PORT);
  Logger.log(
    `API listening on http://localhost:${env.API_PORT} (health: /health${monitored ? ', Sentry on' : ''})`,
    'Bootstrap',
  );
}

void bootstrap();
