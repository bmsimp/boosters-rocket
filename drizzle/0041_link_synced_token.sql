-- Stage 3's slice 9e: a rename of a linked family, member or student, and a student added to a linked family, are saved
-- in the portal first, and a rename is sent with the version its link last aligned with (`synced_token`), never the
-- page's. Only those two change how they are sent, so the update refuses, in words, changing nothing, while one queued
-- before this release is waiting or stuck for the roster's company (a rename of a family, member or student, or a
-- student's create, carrying what a page sent): staff clear them on the Reconciliation page ("Try again now" or "Give
-- up"), then update again. A move, a make-inactive, a Parent customer's change, a family's own create, a buy-out's
-- invoice writes, an item that is done or given up, and another company's item don't count.
DO $$
DECLARE
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
  open_writes integer;
BEGIN
  SELECT count(*) INTO open_writes FROM "write_queue"
  WHERE "state" IN ('waiting', 'stuck') AND "realm_id" = realm
    AND (("request"->>'op' = 'rename' AND "request"->>'role' IN ('family', 'member', 'student'))
      OR ("request"->>'op' = 'create' AND "request"->>'role' = 'student'));
  IF open_writes > 0 THEN
    RAISE EXCEPTION 'Migration 0041 stopped, and changed nothing: % staff change(s) to the roster are still waiting or stuck on the queue (a rename of a family, member or student, or a new student). Clear them on the Reconciliation page, with "Try again now" or "Give up", then update again.', open_writes;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "accounting_link" ADD COLUMN "synced_token" text;--> statement-breakpoint
ALTER TABLE "accounting_link" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
-- Each link of the roster's company (guardian links too) starts aligned with the version the roster cache holds for its
-- customer; a link whose customer the cache doesn't hold, and every link while the cache names no company, stays null.
DO $$
DECLARE
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
BEGIN
  IF realm IS NULL THEN
    RETURN;
  END IF;
  UPDATE "accounting_link" l SET "synced_token" = c."sync_token", "synced_at" = now()
  FROM "qbo_customer" c
  WHERE c."qbo_id" = l."customer_id" AND l."system" = 'quickbooks' AND l."realm_id" = realm;
END $$;
