ALTER TABLE `queue_batches` ADD `lease_id` text;--> statement-breakpoint
CREATE INDEX `idx_queue_batches_lease` ON `queue_batches` (`lease_id`);--> statement-breakpoint
ALTER TABLE `tenants` ADD `lease_id` text;