-- buy-outs re-key: the finish. A buy-out names its family and student by the app's own ids alone (0030 filled them), so
-- its QuickBooks columns for the family and the subject go; the customer billed, the item, the invoice and the company
-- stay. One live buy-out per requirement and family for a per-family one, and per requirement and student, whichever
-- family chose it, for a per-student one.
DROP INDEX "buyout_live_uq";--> statement-breakpoint
DROP INDEX "buyout_family_ix";--> statement-breakpoint
ALTER TABLE "buyout" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "buyout_family_live_uq" ON "buyout" USING btree ("requirement_id","family_id") WHERE state not in ('voided', 'refused') and student_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "buyout_student_live_uq" ON "buyout" USING btree ("requirement_id","student_id") WHERE state not in ('voided', 'refused') and student_id is not null;--> statement-breakpoint
CREATE INDEX "buyout_family_id_ix" ON "buyout" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "buyout_student_id_ix" ON "buyout" USING btree ("student_id");--> statement-breakpoint
ALTER TABLE "buyout" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "buyout" DROP COLUMN "subject_qbo_id";