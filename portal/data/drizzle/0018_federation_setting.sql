ALTER TABLE "portal"."tenant_register" ADD COLUMN "federation_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD COLUMN "federation_updated_by" text;--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD COLUMN "federation_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD CONSTRAINT "tenant_register_federation_demo_off" CHECK (NOT ("portal"."tenant_register"."federation_enabled" AND "portal"."tenant_register"."kind" = 'DEMO'));