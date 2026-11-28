-- Custom SQL migration file, put your code below! --
-- Stage 5's slice P2 (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 2): "Families with no
-- active student" no longer waits for a membership shape that names a student type. Before it, a value stored on beside
-- a shape with none (flat, layered with no student type, or no shape at all) was not in force, so nobody was kept out
-- by it; switching it off here keeps it so, audited as the save it is, and an Admin can switch it on from Parent sign-ins.
WITH "changed" AS (
  UPDATE "setting"
  SET "value" = jsonb_set("value", '{requireActiveStudents}', 'false'::jsonb), "updated_at" = now()
  WHERE "key" = 'parents.settings'
    AND ("value"->>'requireActiveStudents') = 'true'
    AND NOT EXISTS (
      SELECT 1 FROM "setting" s
      WHERE s."key" = 'membership.shape' AND s."value"->>'kind' = 'layered' AND jsonb_typeof(s."value"->'studentTypeId') = 'string'
    )
  RETURNING "value"
)
INSERT INTO "audit_log" ("door", "actor_label", "action", "target_type", "target_id", "before", "after")
  SELECT 'system', 'migration', 'settings.parents.save', 'setting', 'parents.settings',
    jsonb_set("value", '{requireActiveStudents}', 'true'::jsonb), "value" || jsonb_build_object('cause', 'migration 0062_students_rule_kept')
  FROM "changed";
