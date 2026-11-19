-- Stage 3's slice 9f: moving a student is saved in the portal first, and the move's follow-ups (the student's forms,
-- volunteer places and buy-outs) run once, at that save, by the app's own records. A move queued before this release
-- was saved QuickBooks first: its follow-ups would run when QuickBooks answers, the old order, and its student's record
-- would follow only then. So the update refuses, in words, changing nothing, while one is waiting or stuck for the
-- roster's company: staff clear them on the Reconciliation page ("Try again now" or "Give up"), then update again. A
-- rename, a create, a make-inactive, a Parent customer's change, a buy-out's invoice writes, a move that is done, given
-- up or refused, and another company's item don't count; with no roster company nothing counts.
DO $$
DECLARE
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
  open_moves integer;
BEGIN
  SELECT count(*) INTO open_moves FROM "write_queue"
  WHERE "state" IN ('waiting', 'stuck') AND "realm_id" = realm AND "request"->>'op' = 'move';
  IF open_moves > 0 THEN
    RAISE EXCEPTION 'Migration 0042 stopped, and changed nothing: % staff move(s) of a student are still waiting or stuck on the queue. Clear them on the Reconciliation page, with "Try again now" or "Give up", then update again.', open_moves;
  END IF;
END $$;
