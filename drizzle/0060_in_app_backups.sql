CREATE TABLE "backup_file" (
	"backup_at" text PRIMARY KEY NOT NULL,
	"portal_bytes" bigint NOT NULL,
	"documenso_bytes" bigint,
	"schema_at" bigint,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offsite_at" timestamp with time zone,
	"offsite_outcome" text,
	CONSTRAINT "backup_file_backup_at_shape" CHECK ("backup_file"."backup_at" ~ '^[0-9]{8}T[0-9]{6}Z$')
);
--> statement-breakpoint
CREATE TABLE "backup_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"backup_at" text,
	"requested_by" text,
	"requested_label" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"words" text,
	"result" jsonb,
	CONSTRAINT "backup_request_backup_at_shape" CHECK ("backup_request"."backup_at" is null or "backup_request"."backup_at" ~ '^[0-9]{8}T[0-9]{6}Z$'),
	CONSTRAINT "backup_request_words_length" CHECK ("backup_request"."words" is null or char_length("backup_request"."words") <= 500),
	CONSTRAINT "backup_request_finished_with_outcome" CHECK (("backup_request"."finished_at" is null) = ("backup_request"."outcome" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "backup_request_unfinished_uq" ON "backup_request" USING btree ("kind") WHERE finished_at is null;--> statement-breakpoint
CREATE INDEX "backup_request_requested_ix" ON "backup_request" USING btree ("requested_at");