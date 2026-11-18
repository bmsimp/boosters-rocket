-- volunteering re-key: the reminder claims' keys. A due-date nudge's claim is keyed by the family, the due date and
-- the guardian; the family in it becomes the app's own family 0026 gave the claim, so a nudge already sent (or under
-- way) is found under its new key and never goes twice. A day-before claim is keyed by its sign-up and date, and
-- names no family. A claim whose key doesn't start with its family is not guessed at: the check stops the migration.
UPDATE "volunteer_reminder" SET "key" = "family_id"::text || substr("key", length("family_qbo_id") + 1)
  WHERE "kind" IN ('due_14', 'due_3') AND left("key", length("family_qbo_id") + 1) = "family_qbo_id" || '|';
--> statement-breakpoint
DO $$
DECLARE stale bigint;
BEGIN
  SELECT count(*) INTO stale FROM "volunteer_reminder" WHERE "kind" IN ('due_14', 'due_3') AND left("key", 37) <> "family_id"::text || '|';
  IF stale > 0 THEN
    RAISE EXCEPTION 'Migration 0027 stopped, and changed nothing: % due-date reminder claims have a key that doesn''t start with their family. Keep the database as it is and report this.', stale;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "volunteer_credit" DROP CONSTRAINT "volunteer_credit_source";--> statement-breakpoint
ALTER TABLE "volunteer_signup" DROP CONSTRAINT "volunteer_signup_filler";--> statement-breakpoint
DROP INDEX "volunteer_credit_family_ix";--> statement-breakpoint
DROP INDEX "volunteer_signup_family_ix";--> statement-breakpoint
DROP INDEX "volunteer_signup_student_ix";--> statement-breakpoint
DROP INDEX "volunteer_signup_student_uq";--> statement-breakpoint
ALTER TABLE "volunteer_credit" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "volunteer_reminder" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "volunteer_credit_family_id_ix" ON "volunteer_credit" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "volunteer_credit_student_id_ix" ON "volunteer_credit" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "volunteer_reminder_family_id_ix" ON "volunteer_reminder" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "volunteer_signup_family_id_ix" ON "volunteer_signup" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "volunteer_signup_student_id_ix" ON "volunteer_signup" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_signup_student_id_uq" ON "volunteer_signup" USING btree ("shift_id","student_id") WHERE cancelled_at is null and filler_kind = 'student';--> statement-breakpoint
ALTER TABLE "volunteer_credit" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "volunteer_credit" DROP COLUMN "student_qbo_id";--> statement-breakpoint
ALTER TABLE "volunteer_reminder" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "volunteer_signup" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "volunteer_signup" DROP COLUMN "student_qbo_id";--> statement-breakpoint
ALTER TABLE "volunteer_credit" ADD CONSTRAINT "volunteer_credit_source_record" CHECK (("volunteer_credit"."kind" in ('checkin', 'staff_checkin') and "volunteer_credit"."signup_id" is not null and "volunteer_credit"."requirement_id" is null and "volunteer_credit"."student_id" is null) or ("volunteer_credit"."kind" = 'outside' and "volunteer_credit"."signup_id" is null and "volunteer_credit"."requirement_id" is not null));--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_filler_record" CHECK (("volunteer_signup"."filler_kind" = 'guardian' and "volunteer_signup"."filler_parent_id" is not null and "volunteer_signup"."student_id" is null) or ("volunteer_signup"."filler_kind" = 'student' and "volunteer_signup"."student_id" is not null and "volunteer_signup"."filler_parent_id" is null));