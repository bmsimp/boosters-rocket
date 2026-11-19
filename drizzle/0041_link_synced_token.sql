-- Stage 3's slice 9e: a rename of a linked record is saved in the portal first and sent with the version its link last
-- aligned with (`synced_token`), never the page's. A roster write queued before this release carries a version from a
-- page, so the update refuses, in words, changing nothing, while any is waiting or stuck: staff clear them on the
-- Reconciliation page ("Try again now" or "Give up"), then update again. A buy-out's invoice writes and a make-inactive
-- don't count.
DO $$
DECLARE
  open_writes integer;
BEGIN
  SELECT count(*) INTO open_writes FROM "write_queue"
  WHERE "state" IN ('waiting', 'stuck') AND "request"->>'op' IN ('create', 'rename', 'move');
  IF open_writes > 0 THEN
    RAISE EXCEPTION 'Migration 0041 stopped, and changed nothing: % staff change(s) to the roster are still waiting or stuck on the queue (a new family, student or parent, a rename or a move). Clear them on the Reconciliation page, with "Try again now" or "Give up", then update again.', open_writes;
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
