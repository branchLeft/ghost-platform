ALTER TABLE "portal"."demo_request" DROP CONSTRAINT "demo_request_verified_address_unique";--> statement-breakpoint
ALTER TABLE "portal"."demo_request" ADD COLUMN "claim_open" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "portal"."demo_request" AS r SET "claim_open" = false WHERE (SELECT e."to_state" FROM "portal"."demo_state_event" AS e WHERE e."demo_id" = r."demo_id" ORDER BY e."sequence" DESC LIMIT 1) = 'FAILED';--> statement-breakpoint
CREATE UNIQUE INDEX "demo_request_one_open_claim_per_address" ON "portal"."demo_request" USING btree ("verified_address") WHERE "portal"."demo_request"."claim_open";--> statement-breakpoint
DROP POLICY "request_insert" ON "portal"."demo_request";--> statement-breakpoint
CREATE POLICY "request_insert" ON "portal"."demo_request" AS PERMISSIVE FOR INSERT TO "portal_prospect" WITH CHECK ("portal"."demo_request"."claim_open");--> statement-breakpoint
CREATE POLICY "provisioner_close_claim" ON "portal"."demo_request" AS PERMISSIVE FOR UPDATE TO "portal_provisioner" USING (true) WITH CHECK ("portal"."demo_request"."claim_open" = false);
