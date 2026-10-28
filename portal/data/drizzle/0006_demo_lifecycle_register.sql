CREATE TABLE "portal"."demo_state_event" (
	"demo_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"previous_sequence" integer,
	"from_state" text,
	"to_state" text NOT NULL,
	"lease_issued_at" timestamp with time zone,
	"lease_ends_at" timestamp with time zone,
	"extension_days" integer DEFAULT 0 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_state_event_demo_id_sequence_pk" PRIMARY KEY("demo_id","sequence"),
	CONSTRAINT "demo_state_event_demo_sequence_state_unique" UNIQUE("demo_id","sequence","to_state"),
	CONSTRAINT "demo_state_event_transition_allowed" CHECK (("portal"."demo_state_event"."from_state" IS NULL AND "portal"."demo_state_event"."sequence" = 1 AND "portal"."demo_state_event"."to_state" = 'VERIFIED') OR ("portal"."demo_state_event"."from_state" IS NOT NULL AND ((from_state = 'VERIFIED' AND to_state IN ('CLAIMED', 'WAITING')) OR (from_state = 'WAITING' AND to_state IN ('CLAIMED')) OR (from_state = 'CLAIMED' AND to_state IN ('PROVISIONING', 'WAITING', 'KILLED', 'FROZEN')) OR (from_state = 'PROVISIONING' AND to_state IN ('LIVE', 'FAILED', 'KILLED', 'FROZEN')) OR (from_state = 'LIVE' AND to_state IN ('EXPIRING', 'EXTENDED', 'PROMOTING', 'REBUILDING', 'KILLED', 'FROZEN')) OR (from_state = 'EXTENDED' AND to_state IN ('EXPIRING', 'PROMOTING', 'KILLED', 'FROZEN')) OR (from_state = 'EXPIRING' AND to_state IN ('PURGED', 'EXTENDED', 'PROMOTING', 'KILLED', 'FROZEN')) OR (from_state = 'REBUILDING' AND to_state IN ('LIVE', 'FAILED', 'KILLED', 'FROZEN')) OR (from_state = 'PROMOTING' AND to_state IN ('PROMOTED', 'LIVE', 'EXTENDED', 'EXPIRING', 'KILLED', 'FROZEN'))))),
	CONSTRAINT "demo_state_event_sequence_chain" CHECK ("portal"."demo_state_event"."sequence" >= 1 AND ("portal"."demo_state_event"."sequence" = 1) = ("portal"."demo_state_event"."previous_sequence" IS NULL) AND ("portal"."demo_state_event"."previous_sequence" IS NULL) = ("portal"."demo_state_event"."from_state" IS NULL) AND ("portal"."demo_state_event"."previous_sequence" IS NULL OR "portal"."demo_state_event"."previous_sequence" = "portal"."demo_state_event"."sequence" - 1)),
	CONSTRAINT "demo_state_event_lease_complete" CHECK (("portal"."demo_state_event"."lease_issued_at" IS NULL) = ("portal"."demo_state_event"."lease_ends_at" IS NULL)),
	CONSTRAINT "demo_state_event_lease_finite" CHECK ("portal"."demo_state_event"."lease_ends_at" > "portal"."demo_state_event"."lease_issued_at"),
	CONSTRAINT "demo_state_event_lease_by_state" CHECK (("portal"."demo_state_event"."to_state" IN ('VERIFIED', 'WAITING', 'CLAIMED') AND "portal"."demo_state_event"."lease_ends_at" IS NULL) OR ("portal"."demo_state_event"."to_state" IN ('PROVISIONING', 'LIVE', 'EXTENDED', 'EXPIRING', 'REBUILDING', 'PROMOTING', 'PROMOTED', 'PURGED') AND "portal"."demo_state_event"."lease_ends_at" IS NOT NULL) OR "portal"."demo_state_event"."to_state" IN ('FAILED', 'KILLED', 'FROZEN')),
	CONSTRAINT "demo_state_event_term_set" CHECK ("portal"."demo_state_event"."to_state" <> 'PROVISIONING' OR ("portal"."demo_state_event"."lease_issued_at" = "portal"."demo_state_event"."recorded_at" AND "portal"."demo_state_event"."lease_ends_at" = "portal"."demo_state_event"."lease_issued_at" + make_interval(hours => 168))),
	CONSTRAINT "demo_state_event_extension_only_extended" CHECK ("portal"."demo_state_event"."extension_days" >= 0 AND ("portal"."demo_state_event"."extension_days" = 0 OR "portal"."demo_state_event"."to_state" = 'EXTENDED'))
);
--> statement-breakpoint
CREATE TABLE "portal"."hostname_register" (
	"label" text PRIMARY KEY NOT NULL,
	"demo_id" uuid NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hostname_register_demo_id_unique" UNIQUE("demo_id"),
	CONSTRAINT "hostname_register_label_shape" CHECK ("portal"."hostname_register"."label" ~ '^[a-z2-7]{20}$')
);
--> statement-breakpoint
CREATE TABLE "portal"."hostname_retirement" (
	"label" text PRIMARY KEY NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal"."demo_state_event" ADD CONSTRAINT "demo_state_event_continues_previous_fk" FOREIGN KEY ("demo_id","previous_sequence","from_state") REFERENCES "portal"."demo_state_event"("demo_id","sequence","to_state") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal"."hostname_retirement" ADD CONSTRAINT "hostname_retirement_label_hostname_register_label_fk" FOREIGN KEY ("label") REFERENCES "portal"."hostname_register"("label") ON DELETE no action ON UPDATE no action;