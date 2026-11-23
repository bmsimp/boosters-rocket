CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "message_deleted_by_with_at" CHECK (("message"."deleted_by" is null) = ("message"."deleted_at" is null))
);
--> statement-breakpoint
CREATE TABLE "message_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"held_by" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_file_held_or_posted" CHECK ("message_file"."held_by" is not null or "message_file"."message_id" is not null),
	CONSTRAINT "message_file_name_length" CHECK (char_length("message_file"."name") between 1 and 200),
	CONSTRAINT "message_file_size" CHECK ("message_file"."size" between 0 and 10485760)
);
--> statement-breakpoint
CREATE TABLE "message_mail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_mail_address_lower" CHECK ("message_mail"."address" = lower(btrim("message_mail"."address"))),
	CONSTRAINT "message_mail_reason_length" CHECK ("message_mail"."reason" is null or char_length("message_mail"."reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "message_read" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"version_n" integer NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "message_version_n_positive" CHECK ("message_version"."n" >= 1),
	CONSTRAINT "message_version_title_length" CHECK (char_length("message_version"."title") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "message_version_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_user" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_posted_by_staff_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_file" ADD CONSTRAINT "message_file_held_by_staff_user_id_fk" FOREIGN KEY ("held_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mail" ADD CONSTRAINT "message_mail_version_id_message_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."message_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_read" ADD CONSTRAINT "message_read_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_read" ADD CONSTRAINT "message_read_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_version" ADD CONSTRAINT "message_version_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_version_file" ADD CONSTRAINT "message_version_file_version_id_message_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."message_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_version_file" ADD CONSTRAINT "message_version_file_file_id_message_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."message_file"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_posted_at_ix" ON "message" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "message_posted_by_ix" ON "message" USING btree ("posted_by");--> statement-breakpoint
CREATE INDEX "message_file_message_ix" ON "message_file" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_file_held_ix" ON "message_file" USING btree ("held_by");--> statement-breakpoint
CREATE UNIQUE INDEX "message_mail_address_uq" ON "message_mail" USING btree ("version_id","address");--> statement-breakpoint
CREATE INDEX "message_mail_queued_ix" ON "message_mail" USING btree ("status") WHERE status = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "message_read_uq" ON "message_read" USING btree ("message_id","parent_id");--> statement-breakpoint
CREATE INDEX "message_read_parent_ix" ON "message_read" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_version_n_uq" ON "message_version" USING btree ("message_id","n");--> statement-breakpoint
CREATE UNIQUE INDEX "message_version_file_uq" ON "message_version_file" USING btree ("version_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_version_file_position_uq" ON "message_version_file" USING btree ("version_id","position");--> statement-breakpoint
CREATE INDEX "message_version_file_file_ix" ON "message_version_file" USING btree ("file_id");