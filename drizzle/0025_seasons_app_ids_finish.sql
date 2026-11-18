DROP INDEX "requirement_cover_uq";--> statement-breakpoint
DROP INDEX "requirement_cover_subject_ix";--> statement-breakpoint
DROP INDEX "requirement_progress_subject_uq";--> statement-breakpoint
DROP INDEX "requirement_progress_subject_ix";--> statement-breakpoint
DROP INDEX "requirement_reminder_uq";--> statement-breakpoint
ALTER TABLE "requirement_reminder" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_cover_family_uq" ON "requirement_cover" USING btree ("requirement_id","family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_cover_student_uq" ON "requirement_cover" USING btree ("requirement_id","student_id");--> statement-breakpoint
CREATE INDEX "requirement_cover_family_ix" ON "requirement_cover" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "requirement_cover_student_ix" ON "requirement_cover" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_progress_family_uq" ON "requirement_progress" USING btree ("requirement_id","family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_progress_student_uq" ON "requirement_progress" USING btree ("requirement_id","student_id");--> statement-breakpoint
CREATE INDEX "requirement_progress_family_ix" ON "requirement_progress" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "requirement_progress_student_ix" ON "requirement_progress" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_reminder_family_uq" ON "requirement_reminder" USING btree ("kind","family_id","due_on","parent_id");--> statement-breakpoint
CREATE INDEX "requirement_reminder_family_ix" ON "requirement_reminder" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "requirement_cover" DROP COLUMN "subject_qbo_id";--> statement-breakpoint
ALTER TABLE "requirement_progress" DROP COLUMN "subject_qbo_id";--> statement-breakpoint
ALTER TABLE "requirement_reminder" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "requirement_cover" ADD CONSTRAINT "requirement_cover_one_subject" CHECK (num_nonnulls("requirement_cover"."family_id", "requirement_cover"."student_id") = 1);--> statement-breakpoint
ALTER TABLE "requirement_progress" ADD CONSTRAINT "requirement_progress_one_subject" CHECK (num_nonnulls("requirement_progress"."family_id", "requirement_progress"."student_id") = 1);