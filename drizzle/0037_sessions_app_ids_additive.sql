ALTER TABLE "parent_auth_session" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "parent_email_change" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "parent_auth_session" ADD CONSTRAINT "parent_auth_session_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_email_change" ADD CONSTRAINT "parent_email_change_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parent_auth_session_family_ix" ON "parent_auth_session" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "parent_email_change_family_ix" ON "parent_email_change" USING btree ("family_id");--> statement-breakpoint
-- sessions re-key: the check. Stage 3 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- a session's family, and the family a pending change of sign-in address was asked in, become the app's own family
-- record, taken from the person's own guardian row in that family (guardian.family_id). Every open guardian row has
-- that family while the roster names a company (0023's fill and every keep-in-step since give each one its family). An
-- open row without one, then, could never be chosen again by its person, which is a lock-out, not a session to clear:
-- the migration stops here, and nothing is changed. One row can come about by hand: scripts/seed-poc-guardian.mjs, on a
-- proof of concept, inserts an open row with no family until the worker's next roster read gives it one; its runbook
-- (docs/runbooks/poc-linuxdev.md, section 6) has that read done after seeding, before the tester signs in or an upgrade.
DO $$
DECLARE
  rows_missing bigint;
  people_missing bigint;
  realm text := (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string');
BEGIN
  IF realm IS NULL THEN RETURN; END IF;
  SELECT count(*), count(DISTINCT "parent_id") INTO rows_missing, people_missing FROM "guardian" WHERE "status" <> 'disabled' AND "family_id" IS NULL;
  IF rows_missing > 0 THEN
    RAISE EXCEPTION 'Migration 0037 stopped, and changed nothing: % open guardian rows of % people name no family record, while the roster names company %. Keep the database as it is and report this.', rows_missing, people_missing, realm;
  END IF;
END $$;
--> statement-breakpoint
-- sessions re-key: the sessions. A session belongs to its Better Auth user (user_id), whose person is
-- parent_auth_user.parent_id. Its family is the family_id of that person's OPEN guardian row (status not disabled) in
-- the family the session chose (the row's family_qbo_id is the session's; at most one row, guardian_family_parent_uq),
-- when that row names a family. A session that chose a family and can't be carried (no such open row, or the row names
-- no family) keeps family_id null: its parent is sent to choose again among the families they may enter, or, with none
-- left, the gate ends the session as it ends one today. No session is deleted. One that had not chosen stays null.
UPDATE "parent_auth_session" s SET "family_id" = g."family_id"
  FROM "parent_auth_user" u, "guardian" g
  WHERE u."id" = s."user_id" AND g."parent_id" = u."parent_id" AND g."family_qbo_id" = s."family_qbo_id"
    AND g."status" <> 'disabled' AND g."family_id" IS NOT NULL;
--> statement-breakpoint
-- sessions re-key: the email changes. A request's family is its own guardian row's (guardian_id, the row it was asked
-- under) when that row is the person's and in the request's family, else the person's open row in that family. A live
-- request (unused, not expired) that can't be carried is deleted, so its emailed link reads as gone, as a link to a
-- closed family reads; a used or expired one keeps null until the daily clean-up removes it.
UPDATE "parent_email_change" e SET "family_id" = COALESCE(
    (SELECT g."family_id" FROM "guardian" g WHERE g."id" = e."guardian_id" AND g."parent_id" = e."parent_id" AND g."family_qbo_id" = e."family_qbo_id"),
    (SELECT g."family_id" FROM "guardian" g WHERE g."parent_id" = e."parent_id" AND g."family_qbo_id" = e."family_qbo_id" AND g."status" <> 'disabled'))
  WHERE e."family_qbo_id" IS NOT NULL;
--> statement-breakpoint
-- sessions re-key: end. The carry-over's own audit row, with counts, when there was anything to carry; 0038 then drops
-- both family_qbo_id columns.
WITH deleted AS (
  DELETE FROM "parent_email_change" WHERE "family_id" IS NULL AND "used_at" IS NULL AND "expires_at" > now() RETURNING 1
), counts AS (
  SELECT (SELECT count(*) FROM "parent_auth_session" WHERE "family_id" IS NOT NULL) AS sessions_carried,
    (SELECT count(*) FROM "parent_auth_session" WHERE "family_qbo_id" IS NOT NULL AND "family_id" IS NULL) AS sessions_cleared,
    (SELECT count(*) FROM "parent_email_change" WHERE "family_id" IS NOT NULL) AS changes_carried,
    (SELECT count(*) FROM deleted) AS changes_deleted
)
INSERT INTO "audit_log" ("door", "actor_label", "action", "target_type", "after")
  SELECT 'system', 'migration', 'parent.session.carried_over', 'parent_auth_session', jsonb_build_object('cause', 'migration 0037_sessions_app_ids_additive',
    'realmId', (SELECT "value"->>'realmId' FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string'),
    'sessionsCarried', c.sessions_carried, 'sessionsCleared', c.sessions_cleared, 'emailChangesCarried', c.changes_carried, 'emailChangesDeleted', c.changes_deleted)
  FROM counts c WHERE c.sessions_carried + c.sessions_cleared + c.changes_carried + c.changes_deleted > 0;
