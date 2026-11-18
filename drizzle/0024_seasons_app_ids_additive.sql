ALTER TABLE "requirement_cover" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_cover" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_progress" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_progress" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_reminder" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_cover" ADD CONSTRAINT "requirement_cover_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_cover" ADD CONSTRAINT "requirement_cover_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_progress" ADD CONSTRAINT "requirement_progress_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_progress" ADD CONSTRAINT "requirement_progress_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_reminder" ADD CONSTRAINT "requirement_reminder_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- seasons re-key: begin. Stage 2 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- every chosen list entry, tick, waiver and due-date reminder claim is given the app's own family or student, found
-- through the link of the kind its requirement says (a per-family requirement's subject through a family link, a
-- per-student one's through a student link; a reminder claim names a family), in the company the roster cache came
-- from: never by customer id alone. Migration 0023 made a record and link of each kind for every customer these
-- rows name. One that has none is not guessed at: the check below stops the migration, and nothing is changed.
-- The claims are carried over, so a reminder already sent is never sent again. 0025 then drops the QuickBooks columns.
UPDATE "requirement_cover" c SET "family_id" = l."family_id"
  FROM "requirement" r, "accounting_link" l
  WHERE r."id" = c."requirement_id" AND r."applies_to" = 'family' AND l."customer_id" = c."subject_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "requirement_cover" c SET "student_id" = l."student_id"
  FROM "requirement" r, "accounting_link" l
  WHERE r."id" = c."requirement_id" AND r."applies_to" = 'student' AND l."customer_id" = c."subject_qbo_id" AND l."student_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "requirement_progress" p SET "family_id" = l."family_id"
  FROM "requirement" r, "accounting_link" l
  WHERE r."id" = p."requirement_id" AND r."applies_to" = 'family' AND l."customer_id" = p."subject_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "requirement_progress" p SET "student_id" = l."student_id"
  FROM "requirement" r, "accounting_link" l
  WHERE r."id" = p."requirement_id" AND r."applies_to" = 'student' AND l."customer_id" = p."subject_qbo_id" AND l."student_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "requirement_reminder" m SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE l."customer_id" = m."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
-- seasons re-key: the check. Every row now names an app record, or the migration stops here and nothing is changed.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(format('%s rows in %s', n, t), ', ') INTO missing FROM (
    SELECT 'requirement_cover' AS t, count(*) AS n FROM "requirement_cover" WHERE "family_id" IS NULL AND "student_id" IS NULL
    UNION ALL SELECT 'requirement_progress', count(*) FROM "requirement_progress" WHERE "family_id" IS NULL AND "student_id" IS NULL
    UNION ALL SELECT 'requirement_reminder', count(*) FROM "requirement_reminder" WHERE "family_id" IS NULL
  ) x WHERE n > 0;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0024 stopped, and changed nothing: % name a QuickBooks customer that has no family or student record of the kind its requirement asks for, in the company the roster was read from. Keep the database as it is and report this.', missing;
  END IF;
END $$;
