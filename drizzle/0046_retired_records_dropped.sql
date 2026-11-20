-- retired records: by hand. Stage 3's slice 12a of the app-owned families spec drops what nothing reads: the held-address
-- review's table (`held_address`, each address under more than one family with staff's decisions), the match review's
-- (`family_match`, a family of an earlier QuickBooks company matched to one of the connected company), the QuickBooks
-- record an email change was written to (`parent_email_change.record_qbo_id`, written null and read by nothing since
-- slice 11d: a live request keeps working without it), and the two settings the review left
-- (`parents.previous_company`, `parents.review_notice`, which the daily clean-up deleted as a retired feature's). The
-- staff decisions are in the audit log already; one row here keeps the counts of what goes, never an address, a note or
-- a QuickBooks id. Refuses nothing, fills nothing.
INSERT INTO "audit_log" ("door", "actor_label", "action", "target_type", "after")
  SELECT 'system', 'migration', 'parents.retired_records.dropped', 'parent', jsonb_build_object('cause', 'migration 0046_retired_records_dropped',
    'heldAddresses', (SELECT count(*) FROM "held_address"),
    'familyMatches', (SELECT count(*) FROM "family_match"),
    'emailChangesNamingARecord', (SELECT count(*) FROM "parent_email_change" WHERE "record_qbo_id" IS NOT NULL),
    'retiredSettings', (SELECT count(*) FROM "setting" WHERE "key" IN ('parents.previous_company', 'parents.review_notice')));
--> statement-breakpoint
DELETE FROM "setting" WHERE "key" IN ('parents.previous_company', 'parents.review_notice');
--> statement-breakpoint
DROP TABLE "family_match" CASCADE;--> statement-breakpoint
DROP TABLE "held_address" CASCADE;--> statement-breakpoint
ALTER TABLE "parent_email_change" DROP COLUMN "record_qbo_id";
