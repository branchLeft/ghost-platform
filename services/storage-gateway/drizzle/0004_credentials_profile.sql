ALTER TABLE `credentials` ADD `profile` text DEFAULT 'media' NOT NULL CONSTRAINT `credentials_profile_known` CHECK(`profile` IN ('media', 'state'));
