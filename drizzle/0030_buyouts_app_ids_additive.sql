ALTER TABLE "buyout" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "buyout" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "buyout" ADD CONSTRAINT "buyout_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyout" ADD CONSTRAINT "buyout_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- buy-outs re-key: begin. Stage 2 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- every buy-out is given the app's own family that chose it (from family_qbo_id, through a family link) and, for a
-- per-student requirement, the app's own student it is for (from subject_qbo_id, through a student link, the kind the
-- requirement asks for), in the company the roster cache came from: never by customer id alone. A buy-out keeps the
-- family that chose it, so one whose student has since moved, or left the roster, names that family and the student's
-- own record, which is now in another family or inactive. What it bills stays QuickBooks': the customer, the item, the
-- invoice, its version and the company are not touched. Migration 0023 made a record and link of each kind for every
-- customer a buy-out of the roster's company names. One that has none is not guessed at, and nor is a buy-out of
-- another company (a change of company deletes every buy-out): the check below stops the migration, and nothing is
-- changed. 0031 then drops the QuickBooks columns of the family and the subject.
UPDATE "buyout" b SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE b."realm_id" = l."realm_id" AND l."customer_id" = b."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "buyout" b SET "student_id" = l."student_id"
  FROM "requirement" r, "accounting_link" l
  WHERE r."id" = b."requirement_id" AND r."applies_to" = 'student' AND b."realm_id" = l."realm_id" AND l."customer_id" = b."subject_qbo_id" AND l."student_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
-- buy-outs re-key: the check. Every buy-out is of the roster's company and now names an app record of each kind it
-- named a customer as, or the migration stops here and nothing is changed.
DO $$
DECLARE
  missing text;
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
BEGIN
  SELECT string_agg(format('%s %s', n, t), ', ') INTO missing FROM (
    SELECT 'rows in buyout of a company other than the roster''s' AS t, count(*) AS n FROM "buyout" WHERE "realm_id" IS DISTINCT FROM realm
    UNION ALL SELECT 'rows in buyout with no family record', count(*) FROM "buyout" WHERE "realm_id" IS NOT DISTINCT FROM realm AND "family_id" IS NULL
    UNION ALL SELECT 'per-student rows in buyout with no student record', count(*) FROM "buyout" b JOIN "requirement" r ON r."id" = b."requirement_id"
      WHERE b."realm_id" IS NOT DISTINCT FROM realm AND r."applies_to" = 'student' AND b."student_id" IS NULL
    UNION ALL SELECT 'per-family rows in buyout whose subject is not their family', count(*) FROM "buyout" b JOIN "requirement" r ON r."id" = b."requirement_id"
      WHERE r."applies_to" = 'family' AND b."subject_qbo_id" <> b."family_qbo_id"
  ) x WHERE n > 0;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0030 stopped, and changed nothing: %, in the company the roster was read from. Keep the database as it is and report this.', missing;
  END IF;
END $$;
