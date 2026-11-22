CREATE TABLE "portal"."professional_enquiry" (
	"enquiry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal"."professional_enquiry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."professional_enquiry" ADD CONSTRAINT "professional_enquiry_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."professional_enquiry" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."professional_enquiry"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."professional_enquiry"."tenant_id" = public.bound_tenant());