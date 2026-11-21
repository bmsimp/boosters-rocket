-- Stage 3's slice 12b1: nothing reads a guardian row's own copies of its customers (`family_qbo_id`, `source_qbo_id`)
-- any more; a row's family is its record (`family_id`) and the record its sign-in came from is its own membership link,
-- `carried_over` (the take-in of contact details reads that link alone). The import gave every such row its link while
-- the mirror ran, and migration 0023 did for every row it found, so this only makes up a link the import never made: for
-- each guardian row in the roster's company (`roster.source`, as 0041 reads it), not closed by a change of company, whose
-- family record's link names the row's `family_qbo_id`, whose `source_qbo_id` is another customer, and which has no
-- membership link of that company and no ended one (accounting_link_ended): one `carried_over` link to `source_qbo_id`,
-- by nobody, aligned with the cache's version of that customer when the cache holds it (as 0041). It changes no column
-- and no row but the links it adds and its one audit row, refuses nothing, and does nothing while the roster names no
-- company. Each row it skips loses nothing it has that anything reads after this slice:
-- - a row a change of company closed is in no family, and its ids are another company's;
-- - a row whose family record has no link of the company, or whose link names another customer than its copy (a row
--   made while its family had no link, or of a family unlinked since: an unlink clears the copy, stage 4's slice M3b),
--   has no customer of that family to have come from, and the import never linked one;
-- - a row whose source is the family's own customer (books with no parent type, a flat member) has no record of its
--   own: the family's is read through the family's link;
-- - a row that has a membership link already keeps it, whatever it names: the link wins, as the take-in reads it;
-- - a row with an ended link had it ended by an unlink, after which nothing is restored (M3b), so none is made again;
-- - a row with no source never had a record of its own.
-- One audit row in 0044's manner, counts only (never an id): the links made, the rows linked already, the carried-over
-- membership links that disagree with their row's source (or whose row has none), the rows of families unlinked since
-- (a source kept, the link ended), and the rows with a source while the roster names no company. A `created` link (a
-- Parent customer the portal made, stage 3's slice 9h, whose row never had a source) is no disagreement.
WITH "realm" AS (
  SELECT "value"->>'realmId' AS "id" FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string'
), "member" AS (
  SELECT m."guardian_id", m."customer_id", m."origin" FROM "accounting_link" m
  WHERE m."guardian_id" IS NOT NULL AND m."system" = 'quickbooks' AND m."realm_id" = (SELECT "id" FROM "realm")
), "own" AS (
  SELECT g."id", g."source_qbo_id" FROM "guardian" g
  JOIN "accounting_link" fl ON fl."family_id" = g."family_id" AND fl."system" = 'quickbooks' AND fl."realm_id" = (SELECT "id" FROM "realm")
  WHERE g."disabled_reason" IS DISTINCT FROM 'company_changed' AND g."source_qbo_id" IS NOT NULL
    AND fl."customer_id" = g."family_qbo_id" AND g."source_qbo_id" <> fl."customer_id"
), "made" AS (
  INSERT INTO "accounting_link" ("system", "realm_id", "customer_id", "guardian_id", "origin", "synced_token", "synced_at")
  SELECT 'quickbooks', (SELECT "id" FROM "realm"), o."source_qbo_id", o."id", 'carried_over', c."sync_token", CASE WHEN c."qbo_id" IS NULL THEN NULL ELSE now() END
  FROM "own" o LEFT JOIN "qbo_customer" c ON c."qbo_id" = o."source_qbo_id"
  WHERE NOT EXISTS (SELECT 1 FROM "member" m WHERE m."guardian_id" = o."id")
    AND NOT EXISTS (SELECT 1 FROM "accounting_link_ended" e WHERE e."guardian_id" = o."id")
  RETURNING "guardian_id"
)
INSERT INTO "audit_log" ("door", "actor_label", "action", "target_type", "after")
  SELECT 'system', 'migration', 'parents.guardian_links.filled', 'accounting_link', jsonb_build_object('cause', 'migration 0048_guardian_links_additive',
    'linksMade', (SELECT count(*) FROM "made"),
    'rowsAlreadyLinked', (SELECT count(*) FROM "own" o JOIN "member" m ON m."guardian_id" = o."id" AND m."customer_id" = o."source_qbo_id"),
    'linksDisagreeing', (SELECT count(*) FROM "member" m JOIN "guardian" g ON g."id" = m."guardian_id"
      WHERE m."origin" = 'carried_over' AND g."disabled_reason" IS DISTINCT FROM 'company_changed' AND (g."source_qbo_id" IS NULL OR m."customer_id" <> g."source_qbo_id")),
    'rowsOfFamiliesUnlinked', (SELECT count(*) FROM "guardian" g
      WHERE EXISTS (SELECT 1 FROM "realm") AND g."disabled_reason" IS DISTINCT FROM 'company_changed' AND g."source_qbo_id" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "member" m WHERE m."guardian_id" = g."id")
        AND EXISTS (SELECT 1 FROM "accounting_link_ended" e WHERE e."guardian_id" = g."id")),
    'rowsWithASourceAndNoCompany', (SELECT count(*) FROM "guardian" g
      WHERE NOT EXISTS (SELECT 1 FROM "realm") AND g."disabled_reason" IS DISTINCT FROM 'company_changed' AND g."source_qbo_id" IS NOT NULL));
