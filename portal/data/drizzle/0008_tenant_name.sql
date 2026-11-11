ALTER TABLE "portal"."tenant_register" ADD COLUMN "tenant_name" text;--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD CONSTRAINT "tenant_register_tenant_name_unique" UNIQUE("tenant_name");--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD CONSTRAINT "tenant_register_tenant_name_shape" CHECK ("portal"."tenant_register"."tenant_name" ~ '^[a-z][a-z0-9-]{1,24}[a-z0-9]$');
