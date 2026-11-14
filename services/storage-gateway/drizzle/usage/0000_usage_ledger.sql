CREATE TABLE `multipart_parts` (
	`key_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`key_id`, `upload_id`, `part_number`),
	CONSTRAINT "multipart_parts_size_nonnegative" CHECK("multipart_parts"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`key_id` text NOT NULL,
	`operation` text NOT NULL,
	`requests` integer NOT NULL,
	`billable_in` integer NOT NULL,
	`billable_out` integer NOT NULL,
	PRIMARY KEY(`key_id`, `operation`)
);
--> statement-breakpoint
CREATE TABLE `write_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_id` text NOT NULL,
	`folder` text NOT NULL,
	`bucket` text NOT NULL,
	`object_key` text NOT NULL,
	`size` integer NOT NULL,
	`operation` text NOT NULL,
	`written_at` text NOT NULL,
	CONSTRAINT "write_ledger_size_nonnegative" CHECK("write_ledger"."size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `write_ledger_by_folder` ON `write_ledger` (`folder`,`object_key`);