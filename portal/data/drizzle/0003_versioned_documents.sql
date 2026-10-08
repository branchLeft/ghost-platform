CREATE TABLE "portal"."document_acceptance" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"accepted_by" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_acceptance_tenant_id_kind_version_pk" PRIMARY KEY("tenant_id","kind","version"),
	CONSTRAINT "document_acceptance_kind_acceptable" CHECK ("portal"."document_acceptance"."kind" IN ('terms', 'usage'))
);
--> statement-breakpoint
ALTER TABLE "portal"."document_acceptance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "portal"."document_version" (
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"notice_days" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_version_kind_version_pk" PRIMARY KEY("kind","version"),
	CONSTRAINT "document_version_kind_known" CHECK ("portal"."document_version"."kind" IN ('terms', 'usage', 'subprocessors')),
	CONSTRAINT "document_version_version_positive" CHECK ("portal"."document_version"."version" >= 1),
	CONSTRAINT "document_version_notice_not_negative" CHECK ("portal"."document_version"."notice_days" >= 0),
	CONSTRAINT "document_version_notice_elapsed" CHECK ("portal"."document_version"."effective_at" >= "portal"."document_version"."published_at" + make_interval(hours => "portal"."document_version"."notice_days" * 24)),
	CONSTRAINT "document_version_subprocessors_noticed" CHECK ("portal"."document_version"."kind" <> 'subprocessors' OR "portal"."document_version"."notice_days" >= 1)
);
--> statement-breakpoint
ALTER TABLE "portal"."document_acceptance" ADD CONSTRAINT "document_acceptance_tenant_id_tenant_register_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "portal"."tenant_register"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal"."document_acceptance" ADD CONSTRAINT "document_acceptance_kind_version_document_version_kind_version_fk" FOREIGN KEY ("kind","version") REFERENCES "portal"."document_version"("kind","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "portal"."document_acceptance" AS PERMISSIVE FOR ALL TO "portal_tenant" USING ("portal"."document_acceptance"."tenant_id" = public.bound_tenant()) WITH CHECK ("portal"."document_acceptance"."tenant_id" = public.bound_tenant());
