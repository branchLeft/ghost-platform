CREATE SCHEMA "portal_test";
--> statement-breakpoint
CREATE TABLE "portal_test"."leaky" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_test"."note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_test"."note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal_test"."note" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal_test"."note"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal_test"."note"."tenant_id" = public.bound_tenant());
