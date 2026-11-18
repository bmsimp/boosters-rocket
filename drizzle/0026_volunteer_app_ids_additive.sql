ALTER TABLE "volunteer_credit" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_credit" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_reminder" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "volunteer_credit" ADD CONSTRAINT "volunteer_credit_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_credit" ADD CONSTRAINT "volunteer_credit_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_reminder" ADD CONSTRAINT "volunteer_reminder_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- volunteering re-key: begin. Stage 2 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- every sign-up, credit and reminder claim is given the app's own family, and a sign-up a student fills, or credit
-- for one student, the app's own student: each found through the link of the kind its column holds (a family column
-- through a family link, a student column through a student link), in the company the roster cache came from, never
-- by customer id alone. A sign-up keeps the family it was made from, so a place whose student has since moved, or left
-- the roster, names the old family and the student's own record, which is now in another family or inactive: neither
-- family counts it, as before. Migration 0023 made a record and link of each kind for every customer these rows name.
-- One that has none is not guessed at: the check below stops the migration, and nothing is changed. 0027 rewrites the
-- family inside each due-date claim's key, so no reminder goes twice, and drops the QuickBooks columns.
UPDATE "volunteer_signup" s SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE l."customer_id" = s."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "volunteer_signup" s SET "student_id" = l."student_id"
  FROM "accounting_link" l
  WHERE s."student_qbo_id" IS NOT NULL AND l."customer_id" = s."student_qbo_id" AND l."student_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "volunteer_credit" c SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE l."customer_id" = c."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "volunteer_credit" c SET "student_id" = l."student_id"
  FROM "accounting_link" l
  WHERE c."student_qbo_id" IS NOT NULL AND l."customer_id" = c."student_qbo_id" AND l."student_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "volunteer_reminder" m SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE l."customer_id" = m."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
-- volunteering re-key: the check. Every row now names an app record of each kind it named a customer as, or the
-- migration stops here and nothing is changed.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(format('%s rows in %s', n, t), ', ') INTO missing FROM (
    SELECT 'volunteer_signup' AS t, count(*) AS n FROM "volunteer_signup" WHERE "family_id" IS NULL OR ("student_qbo_id" IS NOT NULL AND "student_id" IS NULL)
    UNION ALL SELECT 'volunteer_credit', count(*) FROM "volunteer_credit" WHERE "family_id" IS NULL OR ("student_qbo_id" IS NOT NULL AND "student_id" IS NULL)
    UNION ALL SELECT 'volunteer_reminder', count(*) FROM "volunteer_reminder" WHERE "family_id" IS NULL
  ) x WHERE n > 0;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0026 stopped, and changed nothing: % name a QuickBooks customer that has no family or student record of the kind its column holds, in the company the roster was read from. Keep the database as it is and report this.', missing;
  END IF;
END $$;
