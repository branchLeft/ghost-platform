ALTER TABLE "portal"."tenant_register" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD CONSTRAINT "tenant_register_kind_known" CHECK ("portal"."tenant_register"."kind" IN ('REAL', 'DEMO'));
