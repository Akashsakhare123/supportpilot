import { Global, Module } from '@nestjs/common';
import type { ApiEnv } from '@supportpilot/shared/node';
import { ENV } from '../config/env';
import { BillingController, StripeWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { PlanLimitGuard } from './plan-limit.guard';
import { PlanLimitsService } from './plan-limits.service';
import { SdkStripeGateway, STRIPE_GATEWAY } from './stripe.gateway';

/**
 * Stripe billing and plan limits (T13). Global so chat, documents and invites can check limits
 * (PlanLimitsService, @PlanLimit guard) without importing billing.
 */
@Global()
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [
    BillingService,
    PlanLimitsService,
    PlanLimitGuard,
    {
      provide: STRIPE_GATEWAY,
      inject: [ENV],
      useFactory: (env: ApiEnv) => new SdkStripeGateway(env.STRIPE_SECRET_KEY),
    },
  ],
  exports: [PlanLimitsService, PlanLimitGuard],
})
export class BillingModule {}
