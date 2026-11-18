-- forms re-key: the finish. A request names its family and student by the app's own ids alone (0028 filled them), so its
-- QuickBooks columns go. Signed-form evidence keeps every column it had: its QuickBooks ids are the record's own copies.
-- From here the database refuses evidence of the current company that names no family, and an earlier company's that
-- names one.
DROP INDEX "signature_request_subject_uq";--> statement-breakpoint
DROP INDEX "signature_request_family_ix";--> statement-breakpoint
ALTER TABLE "signature_request" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "signature_request_family_uq" ON "signature_request" USING btree ("requirement_id","family_id") WHERE student_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "signature_request_student_uq" ON "signature_request" USING btree ("requirement_id","student_id") WHERE student_id is not null;--> statement-breakpoint
CREATE INDEX "signature_request_family_id_ix" ON "signature_request" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "signature_request_student_id_ix" ON "signature_request" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "signed_form_evidence_family_id_ix" ON "signed_form_evidence" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "signed_form_evidence_student_id_ix" ON "signed_form_evidence" USING btree ("student_id");--> statement-breakpoint
ALTER TABLE "signature_request" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "signature_request" DROP COLUMN "subject_qbo_id";--> statement-breakpoint
ALTER TABLE "signed_form_evidence" ADD CONSTRAINT "signed_form_evidence_app_records" CHECK (("signed_form_evidence"."earlier_company_at" is not null and "signed_form_evidence"."family_id" is null and "signed_form_evidence"."student_id" is null) or ("signed_form_evidence"."earlier_company_at" is null and "signed_form_evidence"."family_id" is not null and ("signed_form_evidence"."student_id" is null) = ("signed_form_evidence"."subject_kind" = 'family')));