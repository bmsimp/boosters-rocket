CREATE TABLE "volunteer_credit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"signup_id" uuid,
	"family_qbo_id" text NOT NULL,
	"student_qbo_id" text,
	"requirement_id" uuid,
	"minutes" integer NOT NULL,
	"shifts" integer NOT NULL,
	"note" text,
	"created_by_door" text NOT NULL,
	"created_by" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_credit_source" CHECK (("volunteer_credit"."kind" in ('checkin', 'staff_checkin') and "volunteer_credit"."signup_id" is not null and "volunteer_credit"."requirement_id" is null and "volunteer_credit"."student_qbo_id" is null) or ("volunteer_credit"."kind" = 'outside' and "volunteer_credit"."signup_id" is null and "volunteer_credit"."requirement_id" is not null)),
	CONSTRAINT "volunteer_credit_amount" CHECK ("volunteer_credit"."minutes" >= 0 and "volunteer_credit"."shifts" >= 0 and "volunteer_credit"."minutes" + "volunteer_credit"."shifts" > 0)
);
--> statement-breakpoint
CREATE TABLE "volunteer_reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"family_qbo_id" text NOT NULL,
	"tried_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "volunteer_shift" ADD COLUMN "checkin_code" text DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "volunteer_credit" ADD CONSTRAINT "volunteer_credit_signup_id_volunteer_signup_id_fk" FOREIGN KEY ("signup_id") REFERENCES "public"."volunteer_signup"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_credit" ADD CONSTRAINT "volunteer_credit_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "volunteer_credit_family_ix" ON "volunteer_credit" USING btree ("family_qbo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_credit_signup_uq" ON "volunteer_credit" USING btree ("signup_id") WHERE removed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_reminder_kind_key_uq" ON "volunteer_reminder" USING btree ("kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_shift_checkin_code_uq" ON "volunteer_shift" USING btree ("checkin_code");