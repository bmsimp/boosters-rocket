-- Stage 3's slice 9d: a membership may stand while its family has no link, so `family_qbo_id` takes null, and a person
-- is in a family record at most once. It changes no row: two rows of one person naming one family record are refused,
-- in words, before the index is made, and the whole run changes nothing.
DO $$
DECLARE
  twice integer;
BEGIN
  SELECT count(*) INTO twice FROM (
    SELECT family_id, parent_id FROM guardian WHERE family_id IS NOT NULL GROUP BY family_id, parent_id HAVING count(*) > 1
  ) AS d;
  IF twice > 0 THEN
    RAISE EXCEPTION 'Migration 0040 stopped: % family membership(s) are held by more than one guardian row (one person, two or more rows naming the same family record). Each person may be in a family once, and a closed row counts as much as an open one. Nothing was changed. Report it to the portal''s maintainers, who will say which rows to keep: no change made from the staff pages clears it.', twice;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "guardian" ALTER COLUMN "family_qbo_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_family_id_parent_uq" ON "guardian" USING btree ("family_id","parent_id") WHERE family_id is not null;
