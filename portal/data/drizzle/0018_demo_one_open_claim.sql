ALTER TABLE "portal"."demo_request" DROP CONSTRAINT "demo_request_verified_address_unique";--> statement-breakpoint
ALTER TABLE "portal"."demo_request" ADD COLUMN "claim_open" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_request_one_open_claim_per_address" ON "portal"."demo_request" USING btree ("verified_address") WHERE "portal"."demo_request"."claim_open";--> statement-breakpoint
CREATE POLICY "provisioner_close_claim" ON "portal"."demo_request" AS PERMISSIVE FOR UPDATE TO "portal_provisioner" USING (true) WITH CHECK ("portal"."demo_request"."claim_open" = false);
