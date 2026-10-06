CREATE UNIQUE INDEX `uniq_credentials_active_folder` ON `credentials` (`folder`) WHERE "credentials"."state" = 'active';
