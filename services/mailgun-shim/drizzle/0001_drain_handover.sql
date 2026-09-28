-- Hand-written: the pre-drain queue becomes the drain-shaped one in place. See src/store.md#the-drain-handover-migration.
CREATE TABLE `__new_queue_recipients` (
	`id` text NOT NULL,
	`batch_id` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`drain_count` integer DEFAULT 0 NOT NULL,
	`available_at` real NOT NULL,
	`held_until` real,
	`last_error` text,
	PRIMARY KEY(`batch_id`, `recipient`)
);
--> statement-breakpoint
INSERT INTO `__new_queue_recipients`("id", "batch_id", "recipient", "status", "drain_count", "available_at", "held_until", "last_error")
SELECT
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
		|| '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2)
		|| '-' || lower(hex(randomblob(6))),
	"batch_id", "recipient", "status", "attempts", "next_attempt_at", NULL, "last_error"
FROM `queue_recipients`
ORDER BY rowid;
--> statement-breakpoint
DROP TABLE `queue_recipients`;
--> statement-breakpoint
ALTER TABLE `__new_queue_recipients` RENAME TO `queue_recipients`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_recipients_id` ON `queue_recipients` (`id`);
--> statement-breakpoint
CREATE INDEX `idx_queue_recipients_status_available` ON `queue_recipients` (`status`,`available_at`);
--> statement-breakpoint
CREATE INDEX `idx_queue_recipients_status_held_until` ON `queue_recipients` (`status`,`held_until`);
