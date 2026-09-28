CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`domain` text NOT NULL,
	`type` text NOT NULL,
	`severity` text,
	`recipient` text NOT NULL,
	`email_id` text,
	`provider_message_id` text,
	`timestamp` real NOT NULL,
	`error_code` integer,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `idx_events_domain_seq` ON `events` (`domain`,`seq`);--> statement-breakpoint
CREATE TABLE `queue_batches` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`email_id` text,
	`payload` text NOT NULL,
	`created_at` real NOT NULL,
	`completed_at` real
);
--> statement-breakpoint
CREATE TABLE `queue_recipients` (
	`batch_id` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` real NOT NULL,
	`last_error` text,
	PRIMARY KEY(`batch_id`, `recipient`)
);
--> statement-breakpoint
CREATE INDEX `idx_queue_recipients_status_next` ON `queue_recipients` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`domain` text NOT NULL,
	`type` text NOT NULL,
	`email` text NOT NULL,
	PRIMARY KEY(`domain`, `type`, `email`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`domain` text PRIMARY KEY NOT NULL,
	`api_key_salt` text NOT NULL,
	`api_key_hash` text NOT NULL
);
