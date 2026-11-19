ALTER TABLE "write_queue" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "write_queue" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "write_queue" ADD CONSTRAINT "write_queue_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_queue" ADD CONSTRAINT "write_queue_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "write_queue_family_id_ix" ON "write_queue" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "write_queue_student_ix" ON "write_queue" USING btree ("student_id");--> statement-breakpoint
-- write queue re-key: begin. Stage 3 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- every item, in every state, is given the app's own family it is filed under and, for a student's rename, move or
-- make-inactive, the app's own student it is for, in the company the roster cache came from, each through a link of the
-- kind its column holds (a family column through family_id IS NOT NULL, a student column through student_id IS NOT
-- NULL): never by customer id alone. The family is the one family_qbo_id names (the family a new student or parent goes
-- into, the family of the student or parent changed, the family itself for its own rename, the family a student is moved
-- from, the family that chose a buy-out), or, where it names none, the family or member the item changes (a flat-shape
-- member's item names its member only as its target). These are exactly the customers keepAppRecordsInStep()'s refsQuery
-- read from the queue (src/lib/families/in-step.ts) and migration 0023 read as it filled, so each has a record of that
-- kind. What is sent stays QuickBooks': the request, the target, the result and the company are not touched. Null is
-- right where there is no such record: a create of a family or member (its record is made after QuickBooks answers), a
-- parent's own customer (a parent has no family or student record), and an invoice's student. A row of another company
-- is left with nulls: no path makes one (a change of company deletes the queue), the worker never sends it (it tries
-- only the roster's company), and while the roster names no company every row is such a row. A row of the roster's
-- company whose customer has no record of that kind is not guessed at: the check below stops the migration, and nothing
-- is changed. 0035 then drops family_qbo_id.
UPDATE "write_queue" q SET "family_id" = l."family_id"
  FROM "accounting_link" l
  WHERE q."realm_id" = l."realm_id" AND l."family_id" IS NOT NULL
    AND l."customer_id" = COALESCE(q."family_qbo_id", CASE WHEN q."request"->>'op' IN ('rename', 'move', 'deactivate') AND q."request"->>'role' IN ('family', 'member') THEN q."target_qbo_id" END)
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
UPDATE "write_queue" q SET "student_id" = l."student_id"
  FROM "accounting_link" l
  WHERE q."realm_id" = l."realm_id" AND l."student_id" IS NOT NULL AND l."customer_id" = q."target_qbo_id"
    AND q."request"->>'op' IN ('rename', 'move', 'deactivate') AND q."request"->>'role' = 'student'
    AND l."system" = 'quickbooks' AND l."realm_id" = (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
--> statement-breakpoint
-- write queue re-key: the check. Every item of the roster's company that names a family's or a student's customer now
-- names an app record of that kind, or the migration stops here and nothing is changed.
DO $$
DECLARE
  missing text;
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
BEGIN
  SELECT string_agg(format('%s %s', n, t), ', ') INTO missing FROM (
    SELECT 'rows in write_queue with no family record' AS t, count(*) AS n FROM "write_queue"
      WHERE "realm_id" = realm AND "family_id" IS NULL
        AND COALESCE("family_qbo_id", CASE WHEN "request"->>'op' IN ('rename', 'move', 'deactivate') AND "request"->>'role' IN ('family', 'member') THEN "target_qbo_id" END) IS NOT NULL
    UNION ALL SELECT 'student rows in write_queue with no student record', count(*) FROM "write_queue"
      WHERE "realm_id" = realm AND "student_id" IS NULL AND "target_qbo_id" IS NOT NULL
        AND "request"->>'op' IN ('rename', 'move', 'deactivate') AND "request"->>'role' = 'student'
  ) x WHERE n > 0;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0034 stopped, and changed nothing: %, in the company the roster was read from. Keep the database as it is and report this.', missing;
  END IF;
END $$;
