ALTER TABLE `tenants` ADD `sender_local_part` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tenants_sender_address` ON `tenants` (`sender_domain`,`sender_local_part`);