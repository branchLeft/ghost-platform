CREATE TABLE "portal"."account" (
	"account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identity_org_id_unique" UNIQUE("identity_org_id")
);
--> statement-breakpoint
ALTER TABLE "portal"."account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD COLUMN "account_id" uuid;--> statement-breakpoint
-- Backfill: every existing tenant gets an account of its own, holding the
-- identity organisation the tenant already has. gen_random_uuid() is evaluated
-- per row, so no two tenants share an account.
INSERT INTO "portal"."account" ("identity_org_id", "created_at")
SELECT "zitadel_org_id", "created_at" FROM "portal"."tenant_register";--> statement-breakpoint
UPDATE "portal"."tenant_register" SET "account_id" = "portal"."account"."account_id"
FROM "portal"."account"
WHERE "portal"."account"."identity_org_id" = "portal"."tenant_register"."zitadel_org_id";--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "portal"."tenant_register" ADD CONSTRAINT "tenant_register_account_id_account_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "portal"."account"("account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_account" ON "portal"."account" AS PERMISSIVE FOR SELECT TO "portal_tenant" USING ("portal"."account"."account_id" = (SELECT "portal"."tenant_register"."account_id" FROM "portal"."tenant_register" WHERE "portal"."tenant_register"."tenant_id" = public.bound_tenant()));
