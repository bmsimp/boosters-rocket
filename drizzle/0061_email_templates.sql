CREATE TABLE "email_template_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_key" text NOT NULL,
	"n" integer NOT NULL,
	"subject" text,
	"body" jsonb NOT NULL,
	"reset" boolean DEFAULT false NOT NULL,
	"saved_by" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_template_version_n_positive" CHECK ("email_template_version"."n" >= 1),
	CONSTRAINT "email_template_version_key_shape" CHECK ("email_template_version"."email_key" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "email_template_version_subject_length" CHECK ("email_template_version"."subject" is null or char_length("email_template_version"."subject") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "email_template_version" ADD CONSTRAINT "email_template_version_saved_by_staff_user_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_template_version_n_uq" ON "email_template_version" USING btree ("email_key","n");