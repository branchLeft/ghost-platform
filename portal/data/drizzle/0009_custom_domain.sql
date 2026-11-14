CREATE TABLE "portal"."connected_domain" (
	"fqdn" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connected_domain_fqdn_shape" CHECK ("portal"."connected_domain"."fqdn" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$' AND length("portal"."connected_domain"."fqdn") <= 253)
);
--> statement-breakpoint
ALTER TABLE "portal"."connected_domain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portal"."custom_domain_request" (
	"tenant_id" uuid NOT NULL,
	"fqdn" text NOT NULL,
	"verification_token" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "custom_domain_request_tenant_id_fqdn_pk" PRIMARY KEY("tenant_id","fqdn"),
	CONSTRAINT "custom_domain_request_fqdn_shape" CHECK ("portal"."custom_domain_request"."fqdn" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$' AND length("portal"."custom_domain_request"."fqdn") <= 253),
	CONSTRAINT "custom_domain_request_token_shape" CHECK ("portal"."custom_domain_request"."verification_token" ~ '^[a-z2-7]{32}$')
);
--> statement-breakpoint
ALTER TABLE "portal"."custom_domain_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."connected_domain" ADD CONSTRAINT "connected_domain_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal"."custom_domain_request" ADD CONSTRAINT "custom_domain_request_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."connected_domain" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."connected_domain"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."connected_domain"."tenant_id" = public.bound_tenant());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."custom_domain_request" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."custom_domain_request"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."custom_domain_request"."tenant_id" = public.bound_tenant());