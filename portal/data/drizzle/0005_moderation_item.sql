CREATE TABLE "portal"."moderation_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"member_id" text NOT NULL,
	"classifiers" jsonb NOT NULL,
	"status" text NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "moderation_item_subject_unique" UNIQUE("tenant_id","subject_kind","subject_id"),
	CONSTRAINT "moderation_item_subject_kind_known" CHECK ("portal"."moderation_item"."subject_kind" IN ('comment', 'post')),
	CONSTRAINT "moderation_item_status_known" CHECK ("portal"."moderation_item"."status" IN ('held', 'released', 'removed', 'expired')),
	CONSTRAINT "moderation_item_references_bounded" CHECK ("portal"."moderation_item"."subject_id" ~ '^[A-Za-z0-9_.:-]{1,64}$' AND "portal"."moderation_item"."member_id" ~ '^[A-Za-z0-9_.:-]{1,64}$' AND "portal"."moderation_item"."decided_by" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
	CONSTRAINT "moderation_item_classifiers_array" CHECK (jsonb_typeof("portal"."moderation_item"."classifiers") = 'array')
);
--> statement-breakpoint
ALTER TABLE "portal"."moderation_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."moderation_item" ADD CONSTRAINT "moderation_item_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."moderation_item" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."moderation_item"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."moderation_item"."tenant_id" = public.bound_tenant());