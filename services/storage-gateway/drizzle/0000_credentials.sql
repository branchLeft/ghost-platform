CREATE TABLE `credentials` (
	`key_id` text PRIMARY KEY NOT NULL,
	`folder` text NOT NULL,
	`bucket` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "credentials_state_known" CHECK("credentials"."state" IN ('active', 'disabled', 'revoked'))
);
