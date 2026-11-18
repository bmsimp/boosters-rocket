CREATE TABLE "accounting_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system" text NOT NULL,
	"realm_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"family_id" uuid,
	"student_id" uuid,
	"guardian_id" uuid,
	"origin" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_link_one_record" CHECK (num_nonnulls("accounting_link"."family_id", "accounting_link"."student_id", "accounting_link"."guardian_id") = 1),
	CONSTRAINT "accounting_link_carried_over_by_nobody" CHECK ("accounting_link"."origin" <> 'carried_over' or "accounting_link"."linked_by" is null)
);
--> statement-breakpoint
CREATE TABLE "family" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"active" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid,
	"name" text,
	"active" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_active_in_family" CHECK (not "student"."active" or "student"."family_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "guardian" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "accounting_link" ADD CONSTRAINT "accounting_link_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_link" ADD CONSTRAINT "accounting_link_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_link" ADD CONSTRAINT "accounting_link_guardian_id_guardian_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardian"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student" ADD CONSTRAINT "student_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_link_family_customer_uq" ON "accounting_link" USING btree ("system","realm_id","customer_id") WHERE family_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_link_student_customer_uq" ON "accounting_link" USING btree ("system","realm_id","customer_id") WHERE student_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_link_family_uq" ON "accounting_link" USING btree ("family_id","system","realm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_link_student_uq" ON "accounting_link" USING btree ("student_id","system","realm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_link_guardian_uq" ON "accounting_link" USING btree ("guardian_id","system","realm_id");--> statement-breakpoint
CREATE INDEX "student_family_ix" ON "student" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "guardian" ADD CONSTRAINT "guardian_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guardian_family_id_ix" ON "guardian" USING btree ("family_id");
--> statement-breakpoint
-- app-records fill: begin. Stage 1 of the app-owned families spec (docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
-- the app's own families, students and links, made from what the database holds by the rules of src/lib/families/plan.ts,
-- so that stage 2's migrations find them however soon they run after this one. tests/integration/app-records-fill.test.ts
-- runs the part from here to the end marker again, and proves it makes what keepAppRecordsInStep() makes. It makes nothing
-- while the roster cache names no company. Its scratch tables are the session's own (pg_temp), made inside the
-- migration's transaction, and dropped at the end.
-- The company the roster cache came from (getRosterSource()).
CREATE TEMP TABLE app_fill_source AS
  SELECT "value"->>'realmId' AS realm_id FROM "setting" WHERE "key" = 'roster.source' AND jsonb_typeof("value"->'realmId') = 'string';
--> statement-breakpoint
-- The membership shape, read by getShape()'s own rules: flat with one or more member types, or layered with a family type
-- and a student and a parent type that are each a type or null; every type an id of 1 to 64 characters. Any other is no shape.
CREATE TEMP TABLE app_fill_shape AS
  SELECT "value" AS shape FROM "setting" WHERE "key" = 'membership.shape' AND CASE
    WHEN jsonb_typeof("value") <> 'object' THEN false
    WHEN "value"->>'kind' = 'flat' THEN CASE WHEN jsonb_typeof("value"->'memberTypeIds') <> 'array' THEN false
      ELSE jsonb_array_length("value"->'memberTypeIds') > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements("value"->'memberTypeIds') e
        WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') NOT BETWEEN 1 AND 64) END
    WHEN "value"->>'kind' = 'layered' THEN
      jsonb_typeof("value"->'familyTypeId') = 'string' AND char_length("value"->>'familyTypeId') BETWEEN 1 AND 64
      AND coalesce(jsonb_typeof("value"->'studentTypeId') = 'null' OR (jsonb_typeof("value"->'studentTypeId') = 'string' AND char_length("value"->>'studentTypeId') BETWEEN 1 AND 64), false)
      AND coalesce(jsonb_typeof("value"->'parentTypeId') = 'null' OR (jsonb_typeof("value"->'parentTypeId') = 'string' AND char_length("value"->>'parentTypeId') BETWEEN 1 AND 64), false)
    ELSE false END;
--> statement-breakpoint
-- The roster's families: family customers in layered books, members in flat books.
CREATE TEMP TABLE app_fill_roster AS
  SELECT c."qbo_id" AS customer_id, 'family'::text AS kind, NULL::text AS family_customer_id
  FROM "qbo_customer" c CROSS JOIN app_fill_shape s
  WHERE (s.shape->>'kind' = 'flat' AND c."type_qbo_id" IN (SELECT jsonb_array_elements_text(s.shape->'memberTypeIds')))
     OR (s.shape->>'kind' = 'layered' AND c."type_qbo_id" = s.shape->>'familyTypeId');
--> statement-breakpoint
-- The roster's students: a customer of the student type directly under one of those families.
INSERT INTO app_fill_roster
  SELECT c."qbo_id", 'student', c."parent_qbo_id" FROM "qbo_customer" c CROSS JOIN app_fill_shape s
  WHERE s.shape->>'kind' = 'layered' AND c."type_qbo_id" = s.shape->>'studentTypeId'
    AND c."parent_qbo_id" IN (SELECT customer_id FROM app_fill_roster WHERE kind = 'family')
    AND c."qbo_id" NOT IN (SELECT customer_id FROM app_fill_roster WHERE kind = 'family');
--> statement-breakpoint
-- Every customer a record of the current company names, as the kind its column holds (refsQuery in
-- src/lib/families/in-step.ts). Never evidence of an earlier company.
CREATE TEMP TABLE app_fill_ref AS
  SELECT DISTINCT customer_id, kind FROM (
    SELECT "family_qbo_id" AS customer_id, 'family' AS kind FROM "guardian" WHERE "disabled_reason" IS DISTINCT FROM 'company_changed'
    UNION ALL SELECT "family_qbo_id", 'family' FROM "parent_email_change"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "parent_auth_session"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "family_money" WHERE "realm_id" IS NULL OR "realm_id" = (SELECT realm_id FROM app_fill_source)
    UNION ALL SELECT "family_qbo_id", 'family' FROM "write_queue" WHERE "realm_id" = (SELECT realm_id FROM app_fill_source)
    UNION ALL SELECT "target_qbo_id", CASE WHEN "request"->>'role' = 'student' THEN 'student' ELSE 'family' END FROM "write_queue"
      WHERE "realm_id" = (SELECT realm_id FROM app_fill_source) AND "request"->>'op' IN ('rename', 'move', 'deactivate') AND "request"->>'role' IN ('family', 'member', 'student')
    UNION ALL SELECT c."subject_qbo_id", r."applies_to" FROM "requirement_cover" c JOIN "requirement" r ON r."id" = c."requirement_id"
    UNION ALL SELECT p."subject_qbo_id", r."applies_to" FROM "requirement_progress" p JOIN "requirement" r ON r."id" = p."requirement_id"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "requirement_reminder"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "volunteer_signup"
    UNION ALL SELECT "student_qbo_id", 'student' FROM "volunteer_signup"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "volunteer_credit"
    UNION ALL SELECT "student_qbo_id", 'student' FROM "volunteer_credit"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "volunteer_reminder"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "buyout" WHERE "realm_id" = (SELECT realm_id FROM app_fill_source)
    UNION ALL SELECT b."subject_qbo_id", r."applies_to" FROM "buyout" b JOIN "requirement" r ON r."id" = b."requirement_id" WHERE b."realm_id" = (SELECT realm_id FROM app_fill_source)
    UNION ALL SELECT "family_qbo_id", 'family' FROM "signature_request"
    UNION ALL SELECT s."subject_qbo_id", r."applies_to" FROM "signature_request" s JOIN "requirement" r ON r."id" = s."requirement_id"
    UNION ALL SELECT "family_qbo_id", 'family' FROM "signed_form_evidence" WHERE "earlier_company_at" IS NULL AND "realm_id" = (SELECT realm_id FROM app_fill_source)
    UNION ALL SELECT "subject_qbo_id", "subject_kind" FROM "signed_form_evidence" WHERE "earlier_company_at" IS NULL AND "realm_id" = (SELECT realm_id FROM app_fill_source)
  ) refs WHERE customer_id IS NOT NULL AND kind IN ('family', 'student') AND EXISTS (SELECT 1 FROM app_fill_source);
--> statement-breakpoint
-- What the portal last knew a customer as, for one the cache doesn't hold (hintsQuery in src/lib/families/in-step.ts).
CREATE TEMP TABLE app_fill_hint AS
  SELECT DISTINCT ON (customer_id) customer_id, name FROM (
    SELECT "family_qbo_id" AS customer_id, "family_name" AS name, 1 AS rank, "stored_at" AS at, "id" FROM "signed_form_evidence"
      WHERE "earlier_company_at" IS NULL AND "realm_id" = (SELECT realm_id FROM app_fill_source) AND btrim("family_name") <> ''
    UNION ALL SELECT "subject_qbo_id", "subject_name", 1, "stored_at", "id" FROM "signed_form_evidence"
      WHERE "earlier_company_at" IS NULL AND "realm_id" = (SELECT realm_id FROM app_fill_source) AND btrim("subject_name") <> ''
    UNION ALL SELECT "subject_qbo_id", "subject_name", 2, "updated_at", "id" FROM "signature_request" WHERE btrim("subject_name") <> ''
    UNION ALL SELECT "student_qbo_id", "filler_name", 3, "created_at", "id" FROM "volunteer_signup" WHERE "student_qbo_id" IS NOT NULL AND btrim("filler_name") <> ''
  ) hints ORDER BY customer_id, rank, at DESC, id DESC;
--> statement-breakpoint
-- The families: every roster family, active as its customer is, and every customer a record names as a family, inactive
-- when the roster doesn't hold it as one. Named from the cache, else from what the portal last knew, else not at all.
CREATE TEMP TABLE app_fill_family AS
  SELECT k.customer_id, gen_random_uuid() AS id, coalesce(c."display_name", h.name) AS name, coalesce(k.on_roster AND c."active", false) AS active
  FROM (SELECT customer_id, bool_or(on_roster) AS on_roster FROM (
          SELECT customer_id, true AS on_roster FROM app_fill_roster WHERE kind = 'family'
          UNION ALL SELECT customer_id, false FROM app_fill_ref WHERE kind = 'family'
        ) x WHERE EXISTS (SELECT 1 FROM app_fill_source) GROUP BY customer_id) k
    LEFT JOIN "qbo_customer" c ON c."qbo_id" = k.customer_id LEFT JOIN app_fill_hint h ON h.customer_id = k.customer_id;
--> statement-breakpoint
INSERT INTO "family" ("id", "name", "active") SELECT id, name, active FROM app_fill_family;
--> statement-breakpoint
INSERT INTO "accounting_link" ("system", "realm_id", "customer_id", "family_id", "origin")
  SELECT 'quickbooks', s.realm_id, f.customer_id, f.id, 'carried_over' FROM app_fill_family f CROSS JOIN app_fill_source s;
--> statement-breakpoint
-- The students the same way: a roster student is in the family the cache holds them under; any other is inactive, and in
-- none here (the function keeps the family a student was last in, which a first fill never knew).
CREATE TEMP TABLE app_fill_student AS
  SELECT k.customer_id, gen_random_uuid() AS id, coalesce(c."display_name", h.name) AS name, coalesce(k.on_roster AND c."active", false) AS active,
    f.id AS family_id
  FROM (SELECT customer_id, bool_or(on_roster) AS on_roster, max(family_customer_id) AS family_customer_id FROM (
          SELECT customer_id, true AS on_roster, family_customer_id FROM app_fill_roster WHERE kind = 'student'
          UNION ALL SELECT customer_id, false, NULL::text FROM app_fill_ref WHERE kind = 'student'
        ) x WHERE EXISTS (SELECT 1 FROM app_fill_source) GROUP BY customer_id) k
    LEFT JOIN "qbo_customer" c ON c."qbo_id" = k.customer_id LEFT JOIN app_fill_hint h ON h.customer_id = k.customer_id
    LEFT JOIN app_fill_family f ON f.customer_id = k.family_customer_id;
--> statement-breakpoint
INSERT INTO "student" ("id", "name", "active", "family_id") SELECT id, name, active, family_id FROM app_fill_student;
--> statement-breakpoint
INSERT INTO "accounting_link" ("system", "realm_id", "customer_id", "student_id", "origin")
  SELECT 'quickbooks', s.realm_id, st.customer_id, st.id, 'carried_over' FROM app_fill_student st CROSS JOIN app_fill_source s;
--> statement-breakpoint
-- Each guardian row in its family, but one a change of company closed: its ids are another company's.
UPDATE "guardian" g SET "family_id" = f.id FROM app_fill_family f
  WHERE f.customer_id = g."family_qbo_id" AND g."disabled_reason" IS DISTINCT FROM 'company_changed';
--> statement-breakpoint
-- Each such row whose sign-in came from a record of its own, open or closed, linked to that record.
INSERT INTO "accounting_link" ("system", "realm_id", "customer_id", "guardian_id", "origin")
  SELECT 'quickbooks', s.realm_id, g."source_qbo_id", g."id", 'carried_over'
  FROM "guardian" g CROSS JOIN app_fill_source s
  WHERE g."disabled_reason" IS DISTINCT FROM 'company_changed' AND g."source_qbo_id" IS NOT NULL AND g."source_qbo_id" <> g."family_qbo_id";
--> statement-breakpoint
-- app-records fill: end. The carry-over's own audit row (one per run, with counts), then the scratch tables go.
INSERT INTO "audit_log" ("door", "actor_label", "action", "target_type", "after")
  SELECT 'system', 'migration', 'accounting.link.carried_over', 'accounting_link', jsonb_build_object('realmId', s.realm_id, 'cause', 'migration 0023_app_records',
    'families', (SELECT count(*) FROM app_fill_family), 'students', (SELECT count(*) FROM app_fill_student),
    'memberships', (SELECT count(*) FROM "accounting_link" WHERE "guardian_id" IS NOT NULL))
  FROM app_fill_source s WHERE EXISTS (SELECT 1 FROM app_fill_family);
--> statement-breakpoint
DROP TABLE pg_temp.app_fill_source, pg_temp.app_fill_shape, pg_temp.app_fill_roster, pg_temp.app_fill_ref, pg_temp.app_fill_hint,
  pg_temp.app_fill_family, pg_temp.app_fill_student;
