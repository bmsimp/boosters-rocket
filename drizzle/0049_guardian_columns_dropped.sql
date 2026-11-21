-- Stage 3's slice 12b2 of the app-owned families spec: a guardian row's old copies of its QuickBooks customers go
-- (`family_qbo_id`, the family's, and `source_qbo_id`, the record its sign-in came from), with the two indexes on
-- `family_qbo_id`, and a row must have its family record unless a change of company closed it before stage 4's slice M7a
-- (`company_changed`: such a row keeps its history, in no family). Nothing the portal runs reads either column since
-- slice 12b1, or writes one since 12b2's unlink; a row stands on its family record (`family_id`) and its own link.
-- Two refusals, in 0040's manner, counts only, each before anything is changed; the run is one transaction, so a refusal
-- leaves the database as it was, the earlier migrations of the same run included:
-- - a row in no family record that a change of company did not close: its copy of the family's customer is the only
--   family it has, and the check this adds could not hold;
-- - a row 0048's fill would link now (the roster's company, a family link of it naming the row's `family_qbo_id`, a
--   `source_qbo_id` that is another customer, no membership link of that company, no ended link, not closed by a change
--   of company): its source is a record of its own that no link holds yet, and would be lost. Nothing writes the copies
--   since 12b1, so it finds none on a database 0048 ran on.
-- Every other copy dropped is one nothing reads: a family copy of a row with a family record (the record is read, and
-- its link), a source a link already holds or that is the family's own customer, one of a family unlinked since (its
-- link ended, as an unlink restores nothing), and a previous company's (its ids are another company's). One audit row in
-- 0044's and 0048's manner, counts only (never an id), read before the drop: the rows that held a family copy, the rows
-- that held a source, and the rows of a previous company kept with no family. The build before this one still names
-- `family_qbo_id` in an unlink, and a build before slice 12b1 on every guardian read: while one runs beside the migrated
-- database, the seconds until compose replaces it, those fail and can be done again once the new build is up
-- (docs/runbooks/updates.md).
DO $$
DECLARE
  orphaned integer;
BEGIN
  SELECT count(*) INTO orphaned FROM "guardian" WHERE "family_id" IS NULL AND "disabled_reason" IS DISTINCT FROM 'company_changed';
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'Migration 0049 stopped: % guardian row(s) are in no family record of the portal''s and were not closed by a change of QuickBooks company. Each such row''s copy of its QuickBooks family is the only family it has, and this migration removes that copy. Nothing was changed. Report it to the portal''s maintainers, who will say which family record each row belongs in: no change made from the staff pages clears it.', orphaned;
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE
  unlinked integer;
BEGIN
  WITH "realm" AS (
    SELECT "value"->>'realmId' AS "id" FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string'
  )
  SELECT count(*) INTO unlinked FROM "guardian" g
  JOIN "accounting_link" fl ON fl."family_id" = g."family_id" AND fl."system" = 'quickbooks' AND fl."realm_id" = (SELECT "id" FROM "realm")
  WHERE g."disabled_reason" IS DISTINCT FROM 'company_changed' AND g."source_qbo_id" IS NOT NULL
    AND fl."customer_id" = g."family_qbo_id" AND g."source_qbo_id" <> fl."customer_id"
    AND NOT EXISTS (SELECT 1 FROM "accounting_link" m WHERE m."guardian_id" = g."id" AND m."system" = 'quickbooks' AND m."realm_id" = (SELECT "id" FROM "realm"))
    AND NOT EXISTS (SELECT 1 FROM "accounting_link_ended" e WHERE e."guardian_id" = g."id");
  IF unlinked > 0 THEN
    RAISE EXCEPTION 'Migration 0049 stopped: % guardian row(s) hold the QuickBooks record their sign-in came from with no link to it, which migration 0048 would have made. This migration removes that copy, so the record would be lost. Nothing was changed. Report it to the portal''s maintainers, who will make the links: no change made from the staff pages clears it.', unlinked;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "audit_log" ("door", "actor_label", "action", "target_type", "after")
  SELECT 'system', 'migration', 'parents.guardian_columns.dropped', 'guardian', jsonb_build_object('cause', 'migration 0049_guardian_columns_dropped',
    'rowsWithAFamilyCopy', (SELECT count(*) FROM "guardian" WHERE "family_qbo_id" IS NOT NULL),
    'rowsWithASource', (SELECT count(*) FROM "guardian" WHERE "source_qbo_id" IS NOT NULL),
    'previousCompanyRowsWithNoFamily', (SELECT count(*) FROM "guardian" WHERE "family_id" IS NULL AND "disabled_reason" = 'company_changed'));
--> statement-breakpoint
DROP INDEX "guardian_family_parent_uq";--> statement-breakpoint
DROP INDEX "guardian_family_ix";--> statement-breakpoint
ALTER TABLE "guardian" DROP COLUMN "family_qbo_id";--> statement-breakpoint
ALTER TABLE "guardian" DROP COLUMN "source_qbo_id";--> statement-breakpoint
ALTER TABLE "guardian" ADD CONSTRAINT "guardian_family_unless_company_changed" CHECK ("guardian"."family_id" is not null or "guardian"."disabled_reason" is not distinct from 'company_changed');