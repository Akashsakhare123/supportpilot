import { Global, Module } from '@nestjs/common';
import { RateLimiter } from './rate-limiter.service';

/** Rate limiting (T15), available everywhere (middleware, chat, gateways). */
@Global()
@Module({ providers: [RateLimiter], exports: [RateLimiter] })
export class SecurityModule {}
