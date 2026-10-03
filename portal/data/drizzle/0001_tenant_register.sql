CREATE SCHEMA "portal";
--> statement-breakpoint
CREATE TABLE "portal"."tenant_register" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"zitadel_org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_register_zitadel_org_id_unique" UNIQUE("zitadel_org_id")
);
--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."tenant_register" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."tenant_register"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."tenant_register"."tenant_id" = public.bound_tenant());--> statement-breakpoint
CREATE POLICY "organisation_lookup" ON "portal"."tenant_register" AS PERMISSIVE FOR SELECT TO "portal_tenant" USING ("portal"."tenant_register"."zitadel_org_id" = public.bound_organisation());
