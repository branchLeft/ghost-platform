CREATE TABLE "portal"."moderation_setting" (
	"tenant_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"sensitivity" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "moderation_setting_tenant_id_check_id_pk" PRIMARY KEY("tenant_id","check_id"),
	CONSTRAINT "moderation_setting_check_configurable" CHECK ("portal"."moderation_setting"."check_id" IN ('harassment', 'spam', 'sexual_content', 'self_harm', 'off_topic')),
	CONSTRAINT "moderation_setting_sensitivity_known" CHECK ("portal"."moderation_setting"."sensitivity" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
ALTER TABLE "portal"."moderation_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."moderation_setting" ADD CONSTRAINT "moderation_setting_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."moderation_setting" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."moderation_setting"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."moderation_setting"."tenant_id" = public.bound_tenant());
