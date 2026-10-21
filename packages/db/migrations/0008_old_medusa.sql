CREATE TYPE "public"."message_feedback" AS ENUM('up', 'down');--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "first_handoff_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "feedback" "message_feedback";--> statement-breakpoint
CREATE INDEX "conversations_tenant_created_idx" ON "conversations" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- Backfill (hand-written): chats that already went to a person before this column existed.
UPDATE "conversations" c SET "first_handoff_at" = coalesce(
  (SELECT min(m."created_at") FROM "messages" m WHERE m."conversation_id" = c."id" AND m."sender" IN ('system', 'agent')),
  c."updated_at")
WHERE c."status" IN ('waiting', 'human') OR c."handoff_reason" IS NOT NULL
  OR c."assigned_agent_id" IS NOT NULL
  OR EXISTS (SELECT 1 FROM "messages" m WHERE m."conversation_id" = c."id" AND m."sender" = 'agent');
