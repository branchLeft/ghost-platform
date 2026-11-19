CREATE TABLE "portal"."tenant_billing" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"billing_reference" text,
	"payment_state" text NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_billing_payment_state_known" CHECK ("portal"."tenant_billing"."payment_state" IN ('unpaid', 'paid', 'overdue')),
	CONSTRAINT "tenant_billing_reference_shape" CHECK ("portal"."tenant_billing"."billing_reference" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,63}$'),
	CONSTRAINT "tenant_billing_reference_not_card_like" CHECK ("portal"."tenant_billing"."billing_reference" !~ '^([_.:-]?[0-9]){12,}$')
);
--> statement-breakpoint
ALTER TABLE "portal"."tenant_billing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."tenant_billing" ADD CONSTRAINT "tenant_billing_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."tenant_billing" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."tenant_billing"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."tenant_billing"."tenant_id" = public.bound_tenant());