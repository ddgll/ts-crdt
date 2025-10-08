CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`replicaId` text NOT NULL,
	`parents` text NOT NULL,
	`op` text NOT NULL
);
