ALTER TABLE "family_money" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "family_money" ADD CONSTRAINT "family_money_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "family_money_family_id_uq" ON "family_money" USING btree ("family_id");--> statement-breakpoint
-- money cache re-key: begin. Stage 2 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- each family's stored figures are given the app's own family (from family_qbo_id, through a family link, in the
-- company the roster cache came from: never by customer id alone, never through a student link). What is inside a row
-- stays QuickBooks': the company, the invoices with their customers, items and ids, the customer-by-customer check, the
-- totals and every time. The rows are carried, never emptied: an empty cache is not invisible (a paid buy-out would
-- read as invoiced again, a payment line "No invoice yet", Balances "not read yet", and the due-date reminders would
-- send nothing until the next read). Migration 0023 made a family record and link for every family_money row of the
-- roster's company and every row that has only ever failed (realm_id null). A row of another company is treated as
-- absent by every reader, no path writes one, and 0023 made no record for it: it is a cache, not a record, so it is
-- deleted here (only while the roster names a company). A row that still has no record is not guessed at: the check
-- below stops the migration, and nothing is changed. 0033 then makes family_id the key and drops family_qbo_id.
DELETE FROM "family_money"
  WHERE "realm_id" IS NOT NULL
    AND "realm_id" <> (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "family_money" m SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE l."customer_id" = m."family_qbo_id" AND l."family_id" IS NOT NULL
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
-- money cache re-key: the check. Every row left now names an app family record, or the migration stops here and
-- nothing is changed.
DO $$
DECLARE
  missing text;
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
BEGIN
  SELECT string_agg(format('%s %s', n, t), ', ') INTO missing FROM (
    SELECT 'rows in family_money of the roster''s company with no family record' AS t, count(*) AS n FROM "family_money"
      WHERE "realm_id" IS NOT NULL AND "realm_id" IS NOT DISTINCT FROM realm AND "family_id" IS NULL
    UNION ALL SELECT 'rows in family_money that have only ever failed with no family record', count(*) FROM "family_money"
      WHERE "realm_id" IS NULL AND "family_id" IS NULL
    UNION ALL SELECT 'rows in family_money of a company while the roster names none', count(*) FROM "family_money"
      WHERE "realm_id" IS NOT NULL AND realm IS NULL
  ) x WHERE n > 0;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0032 stopped, and changed nothing: %, in the company the roster was read from. Keep the database as it is and report this.', missing;
  END IF;
END $$;
