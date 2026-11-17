CREATE TABLE "volunteer_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"on_date" date NOT NULL,
	"location" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text,
	"copied_from" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_shift" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"places" integer NOT NULL,
	"role" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_shift_places" CHECK ("volunteer_shift"."places" >= 1)
);
--> statement-breakpoint
CREATE TABLE "volunteer_shift_requirement" (
	"shift_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volunteer_signup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"family_qbo_id" text NOT NULL,
	"signed_up_by" uuid NOT NULL,
	"filler_kind" text NOT NULL,
	"filler_parent_id" uuid,
	"student_qbo_id" text,
	"filler_name" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_door" text,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_signup_filler" CHECK (("volunteer_signup"."filler_kind" = 'guardian' and "volunteer_signup"."filler_parent_id" is not null and "volunteer_signup"."student_qbo_id" is null) or ("volunteer_signup"."filler_kind" = 'student' and "volunteer_signup"."student_qbo_id" is not null and "volunteer_signup"."filler_parent_id" is null))
);
--> statement-breakpoint
ALTER TABLE "volunteer_shift" ADD CONSTRAINT "volunteer_shift_event_id_volunteer_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."volunteer_event"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_shift_requirement" ADD CONSTRAINT "volunteer_shift_requirement_shift_id_volunteer_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."volunteer_shift"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_shift_requirement" ADD CONSTRAINT "volunteer_shift_requirement_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_shift_id_volunteer_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."volunteer_shift"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "volunteer_event_date_ix" ON "volunteer_event" USING btree ("on_date");--> statement-breakpoint
CREATE INDEX "volunteer_shift_event_ix" ON "volunteer_shift" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_shift_requirement_uq" ON "volunteer_shift_requirement" USING btree ("shift_id","requirement_id");--> statement-breakpoint
CREATE INDEX "volunteer_shift_requirement_requirement_ix" ON "volunteer_shift_requirement" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "volunteer_signup_shift_ix" ON "volunteer_signup" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "volunteer_signup_family_ix" ON "volunteer_signup" USING btree ("family_qbo_id");--> statement-breakpoint
CREATE INDEX "volunteer_signup_student_ix" ON "volunteer_signup" USING btree ("student_qbo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_signup_guardian_uq" ON "volunteer_signup" USING btree ("shift_id","filler_parent_id") WHERE cancelled_at is null and filler_kind = 'guardian';--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_signup_student_uq" ON "volunteer_signup" USING btree ("shift_id","student_qbo_id") WHERE cancelled_at is null and filler_kind = 'student';