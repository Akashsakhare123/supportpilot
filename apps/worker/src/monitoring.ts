import * as Sentry from '@sentry/node';
import { redactPii } from '@supportpilot/shared';

/** Error tracking for the worker (T16): Sentry when SENTRY_DSN is set; PII scrubbed. */
export function initMonitoring(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.RELEASE_SHA,
    serverName: 'worker',
    tracesSampleRate: 0,
    beforeSend(event) {
      for (const value of event.exception?.values ?? []) {
        if (value.value) value.value = redactPii(value.value).text;
      }
      return event;
    },
  });
  return true;
}

/** A job that failed for good (no retries left) is worth an alert; retried attempts are not. */
export function reportJobFailure(
  error: Error,
  job: { id?: string; attemptsMade: number; opts: { attempts?: number } } | undefined,
): void {
  if (job && job.attemptsMade < (job.opts.attempts ?? 1)) return;
  Sentry.captureException(error, { tags: { jobId: job?.id ?? 'unknown' } });
}
