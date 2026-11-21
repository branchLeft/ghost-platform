CREATE TABLE "portal"."tenant_erasure_request" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"key_destroyed_at" timestamp with time zone,
	CONSTRAINT "tenant_erasure_request_status_known" CHECK ("portal"."tenant_erasure_request"."status" IN ('requested', 'key_destroyed')),
	CONSTRAINT "tenant_erasure_request_destroyed_moment" CHECK (("portal"."tenant_erasure_request"."status" = 'requested' AND "portal"."tenant_erasure_request"."key_destroyed_at" IS NULL) OR ("portal"."tenant_erasure_request"."status" = 'key_destroyed' AND "portal"."tenant_erasure_request"."key_destroyed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "portal"."tenant_erasure_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."tenant_erasure_request" ADD CONSTRAINT "tenant_erasure_request_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."tenant_erasure_request" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."tenant_erasure_request"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."tenant_erasure_request"."tenant_id" = public.bound_tenant());--> statement-breakpoint
CREATE POLICY "tenant_insert_requested" ON "portal"."tenant_erasure_request" AS RESTRICTIVE FOR INSERT TO "portal_tenant" WITH CHECK ("portal"."tenant_erasure_request"."status" = 'requested' AND "portal"."tenant_erasure_request"."key_destroyed_at" IS NULL);