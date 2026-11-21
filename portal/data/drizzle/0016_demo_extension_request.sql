CREATE TABLE "portal"."demo_extension_request" (
	"demo_id" uuid PRIMARY KEY NOT NULL,
	"still_evaluating" text NOT NULL,
	"what_is_missing" text,
	"audience_size" text NOT NULL,
	"charges_readers" boolean NOT NULL,
	"move_when" text NOT NULL,
	"consent_wording" text NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_extension_request_evaluating_length" CHECK (char_length("portal"."demo_extension_request"."still_evaluating") BETWEEN 1 AND 500),
	CONSTRAINT "demo_extension_request_missing_length" CHECK ("portal"."demo_extension_request"."what_is_missing" IS NULL OR char_length("portal"."demo_extension_request"."what_is_missing") BETWEEN 1 AND 500),
	CONSTRAINT "demo_extension_request_choices_shape" CHECK ("portal"."demo_extension_request"."audience_size" ~ '^[a-z0-9-]{1,40}$' AND "portal"."demo_extension_request"."move_when" ~ '^[a-z0-9-]{1,40}$'),
	CONSTRAINT "demo_extension_request_consent_wording_length" CHECK (char_length("portal"."demo_extension_request"."consent_wording") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "portal"."demo_extension_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal"."demo_extension_request" ADD CONSTRAINT "demo_extension_request_demo_id_demo_request_demo_id_fk" FOREIGN KEY ("demo_id") REFERENCES "portal"."demo_request"("demo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "extension_insert" ON "portal"."demo_extension_request" AS PERMISSIVE FOR INSERT TO "portal_prospect" WITH CHECK (EXISTS (SELECT 1 FROM portal.demo_request WHERE demo_request.demo_id = "portal"."demo_extension_request"."demo_id"));--> statement-breakpoint
CREATE POLICY "provisioner_read" ON "portal"."demo_extension_request" AS PERMISSIVE FOR SELECT TO "portal_provisioner" USING (true);