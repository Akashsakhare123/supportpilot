import { type ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { redactPii } from '@supportpilot/shared';

/**
 * Error tracking (T16): Sentry when SENTRY_DSN is set, nothing otherwise. Events are scrubbed
 * of PII (same masking as the logs) and carry no request bodies or cookies.
 */
export function initMonitoring(service: string): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.RELEASE_SHA,
    serverName: service,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
      }
      for (const value of event.exception?.values ?? []) {
        if (value.value) value.value = redactPii(value.value).text;
      }
      if (event.message) event.message = redactPii(event.message).text;
      return event;
    },
  });
  return true;
}

/** Reports unexpected errors (5xx, not validation or auth errors) and keeps Nest's responses. */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException) || exception.getStatus() >= 500) {
      Sentry.captureException(exception);
    }
    super.catch(exception, host);
  }
}
