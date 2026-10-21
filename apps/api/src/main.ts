import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { RedactingLogger } from './common/redacting-logger';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = configureApp(
    await NestFactory.create(AppModule, { rawBody: true, logger: new RedactingLogger() }),
    env,
  );
  await app.listen(env.API_PORT);
  Logger.log(`API listening on http://localhost:${env.API_PORT} (health: /health)`, 'Bootstrap');
}

void bootstrap();
