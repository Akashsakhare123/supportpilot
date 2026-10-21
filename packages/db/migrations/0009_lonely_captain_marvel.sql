CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"tenant_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_price_id" text,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"payment_failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_stripe_customer_id_unique" UNIQUE("stripe_customer_id");