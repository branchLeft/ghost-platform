CREATE TABLE "portal"."support_access_reading" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"lane" text,
	"granted_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "support_access_reading_state_known" CHECK ("portal"."support_access_reading"."state" IN ('open', 'closed', 'unknown')),
	CONSTRAINT "support_access_reading_lane_known" CHECK ("portal"."support_access_reading"."lane" IN ('consented', 'incident'))
);
--> statement-breakpoint
ALTER TABLE "portal"."support_access_reading" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portal"."support_access_request" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "support_access_request_status_known" CHECK ("portal"."support_access_request"."status" IN ('open', 'dealt_with'))
);
--> statement-breakpoint
ALTER TABLE "portal"."support_access_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."support_access_reading" ADD CONSTRAINT "support_access_reading_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal"."support_access_request" ADD CONSTRAINT "support_access_request_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_request_one_open" ON "portal"."support_access_request" USING btree ("tenant_id") WHERE "portal"."support_access_request"."status" = 'open';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."support_access_reading" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."support_access_reading"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."support_access_reading"."tenant_id" = public.bound_tenant());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."support_access_request" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."support_access_request"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."support_access_request"."tenant_id" = public.bound_tenant());--> statement-breakpoint
CREATE POLICY "tenant_insert_open" ON "portal"."support_access_request" AS RESTRICTIVE FOR INSERT TO "portal_tenant" WITH CHECK ("portal"."support_access_request"."status" = 'open');