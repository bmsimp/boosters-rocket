ALTER TABLE "signature_request" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "signature_request" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "signed_form_evidence" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "signed_form_evidence" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_form_evidence" ADD CONSTRAINT "signed_form_evidence_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_form_evidence" ADD CONSTRAINT "signed_form_evidence_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- forms re-key: begin. Stage 2 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- every signature request is given the app's own family whose request it is (from family_qbo_id, through a family
-- link) and, for a per-student form, the app's own student it is signed for (from subject_qbo_id, through a student
-- link, the kind the requirement asks for), in the company the roster cache came from: never by customer id alone. A
-- request keeps the family that holds it, so one whose student has since moved, or left the roster, names that family
-- and the student's own record, which is now in another family or inactive. Signed-form evidence is the club's record:
-- nothing it holds is changed or removed. The current company's (no earlier_company_at, the roster's realm_id) gains the
-- app's family and student beside its own copies of the QuickBooks ids; an earlier company's gains nothing, and is never
-- matched to a family by its numbers. Migration 0023 made a record and link of each kind for every customer these rows
-- name. One that has none is not guessed at: the check below stops the migration, and nothing is changed. 0029 then
-- drops the request's QuickBooks columns; the evidence keeps its own.
UPDATE "signature_request" s SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE l."customer_id" = s."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "signature_request" s SET "student_id" = l."student_id"
  FROM "requirement" r, "accounting_link" l
  WHERE r."id" = s."requirement_id" AND r."applies_to" = 'student' AND l."customer_id" = s."subject_qbo_id" AND l."student_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "signed_form_evidence" e SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE e."earlier_company_at" IS NULL AND e."realm_id" = l."realm_id" AND l."customer_id" = e."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "signed_form_evidence" e SET "student_id" = l."student_id"
  FROM "accounting_link" l
  WHERE e."earlier_company_at" IS NULL AND e."subject_kind" = 'student' AND e."realm_id" = l."realm_id" AND l."customer_id" = e."subject_qbo_id" AND l."student_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
-- forms re-key: the check. Every request, and every piece of the current company's evidence, now names an app record of
-- each kind it named a customer as, or the migration stops here and nothing is changed. Evidence not marked as an
-- earlier company's must be the roster's company's: one of another is not guessed at either.
DO $$
DECLARE
  missing text;
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
BEGIN
  SELECT string_agg(format('%s %s', n, t), ', ') INTO missing FROM (
    SELECT 'rows in signature_request with no family record' AS t, count(*) AS n FROM "signature_request" WHERE "family_id" IS NULL
    UNION ALL SELECT 'per-student rows in signature_request with no student record', count(*) FROM "signature_request" s JOIN "requirement" r ON r."id" = s."requirement_id"
      WHERE r."applies_to" = 'student' AND s."student_id" IS NULL
    UNION ALL SELECT 'per-family rows in signature_request whose subject is not their family', count(*) FROM "signature_request" s JOIN "requirement" r ON r."id" = s."requirement_id"
      WHERE r."applies_to" = 'family' AND s."subject_qbo_id" <> s."family_qbo_id"
    UNION ALL SELECT 'rows in signed_form_evidence of a company other than the roster''s, not marked as an earlier company''s', count(*) FROM "signed_form_evidence"
      WHERE "earlier_company_at" IS NULL AND "realm_id" IS DISTINCT FROM realm
    UNION ALL SELECT 'rows in signed_form_evidence of the roster''s company with no family or student record', count(*) FROM "signed_form_evidence"
      WHERE "earlier_company_at" IS NULL AND "realm_id" IS NOT DISTINCT FROM realm AND ("family_id" IS NULL OR ("subject_kind" = 'student' AND "student_id" IS NULL))
    UNION ALL SELECT 'per-family rows in signed_form_evidence whose subject is not their family', count(*) FROM "signed_form_evidence"
      WHERE "earlier_company_at" IS NULL AND "subject_kind" = 'family' AND "subject_qbo_id" <> "family_qbo_id"
  ) x WHERE n > 0;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0028 stopped, and changed nothing: %, in the company the roster was read from. Keep the database as it is and report this.', missing;
  END IF;
END $$;
