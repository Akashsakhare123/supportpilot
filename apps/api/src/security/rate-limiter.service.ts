import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@supportpilot/shared/node';
import type { Redis } from 'ioredis';
import { ENV } from '../config/env';
import { REDIS } from '../redis/redis.module';

export interface RateResult {
  allowed: boolean;
  /** Requests counted in the current window, this one included. */
  count: number;
  limit: number;
  /** Seconds until the window resets (Retry-After). */
  retryAfter: number;
}

export const TOO_MANY = 'Too many requests. Please wait a moment and try again.';

/** 429 with Retry-After, for limits checked inside handlers and gateways. */
export class TooManyRequestsException extends HttpException {
  constructor(readonly retryAfter: number) {
    super(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'Too Many Requests', message: TOO_MANY },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Fixed-window rate limiter in Redis (T15), shared by every API instance: one INCR + PEXPIRE per
 * check on `rl:<name>:<subject>:<window>`. Limits are multiplied by RATE_LIMIT_MULTIPLIER (0 = off).
 * If Redis fails the request is allowed (fail open) and the error is logged: an outage of the
 * limiter must not take the product down.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);
  readonly multiplier: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.multiplier = env.RATE_LIMIT_MULTIPLIER;
  }

  async consume(
    name: string,
    subject: string,
    limit: number,
    windowMs: number,
  ): Promise<RateResult> {
    const effective = Math.ceil(limit * this.multiplier);
    if (this.multiplier === 0) return { allowed: true, count: 0, limit: effective, retryAfter: 0 };
    const now = Date.now();
    const window = Math.floor(now / windowMs);
    const key = `rl:${name}:${subject}:${window}`;
    const retryAfter = Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));
    try {
      const result = await this.redis.multi().incr(key).pexpire(key, windowMs).exec();
      const count = Number(result?.[0]?.[1] ?? 0);
      return { allowed: count <= effective, count, limit: effective, retryAfter };
    } catch (error) {
      this.logger.warn(
        `Rate limiter unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { allowed: true, count: 0, limit: effective, retryAfter: 0 };
    }
  }

  /** Throw 429 when over the limit. */
  async assert(name: string, subject: string, limit: number, windowMs: number): Promise<void> {
    const result = await this.consume(name, subject, limit, windowMs);
    if (!result.allowed) throw new TooManyRequestsException(result.retryAfter);
  }
}
