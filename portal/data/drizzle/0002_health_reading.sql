CREATE TABLE "portal"."health_reading" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"health" text NOT NULL,
	"reported_version" text,
	"version_match" boolean,
	"mismatch_since" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "health_reading_health_known" CHECK ("portal"."health_reading"."health" IN ('healthy', 'unhealthy', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "portal"."health_reading" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."health_reading" ADD CONSTRAINT "health_reading_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."health_reading" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."health_reading"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."health_reading"."tenant_id" = public.bound_tenant());
