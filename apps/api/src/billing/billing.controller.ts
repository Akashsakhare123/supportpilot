import { Body, Controller, Get, Header, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
  type BillingOverview,
  type BillingRedirect,
  type CheckoutInput,
  checkoutSchema,
} from '@supportpilot/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Public, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BillingService, type WebhookResult } from './billing.service';

/** Billing for owners: current plan and usage, Stripe Checkout and the Customer Portal. */
@Controller('billing')
@Roles('owner')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  overview(@Auth() auth: AuthContext): Promise<BillingOverview> {
    return this.billing.overview(auth.tenantId);
  }

  /** The browser is sent to the returned Stripe Checkout URL; the plan changes by webhook only. */
  @Post('checkout')
  @HttpCode(200)
  async checkout(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(checkoutSchema)) body: CheckoutInput,
  ): Promise<BillingRedirect> {
    return { url: await this.billing.checkout(auth.tenantId, auth.userId, body.plan) };
  }

  @Post('portal')
  @HttpCode(200)
  async portal(@Auth() auth: AuthContext): Promise<BillingRedirect> {
    return { url: await this.billing.portal(auth.tenantId) };
  }
}

/**
 * Stripe webhook endpoint (no login: the Stripe-Signature header over the raw body is the
 * authentication). Answers 2xx once an event is applied or was already applied.
 */
@Public()
@Controller('billing/webhook')
export class StripeWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @HttpCode(200)
  receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<WebhookResult> {
    return this.billing.handleWebhook(req.rawBody, signature);
  }
}
