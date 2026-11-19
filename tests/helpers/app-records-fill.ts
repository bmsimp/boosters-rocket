// The SQL fill of the app's own records in migration 0023, as statements that can be run again on a database that
// holds data (tests/integration/app-records-fill.test.ts, scripts/seed-e2e.ts). Reads nothing but the file, so a
// script that doesn't load the portal's modules can use it.
import { readFileSync } from "node:fs";
import path from "node:path";

export const FILL_MIGRATION = "drizzle/0023_app_records.sql";

/**
 * The lines of 0023's fill that read a column a later migration removed: stage 2 re-keyed those tables to the app's own
 * ids, so their rows name a record by its id and no longer name a customer for the fill to make one of. Each is taken
 * out of the fill when it is run on today's tables, as keepAppRecordsInStep()'s refsQuery left it out
 * (src/lib/families/in-step.ts). A later slice that re-keys a table adds its line here.
 */
export const RE_KEYED_SINCE_0023: { line: string; by: string }[] = [
  { line: `    UNION ALL SELECT c."subject_qbo_id", r."applies_to" FROM "requirement_cover" c JOIN "requirement" r ON r."id" = c."requirement_id"`, by: "0025_seasons_app_ids_finish" },
  { line: `    UNION ALL SELECT p."subject_qbo_id", r."applies_to" FROM "requirement_progress" p JOIN "requirement" r ON r."id" = p."requirement_id"`, by: "0025_seasons_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "requirement_reminder"`, by: "0025_seasons_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "volunteer_signup"`, by: "0027_volunteer_app_ids_finish" },
  { line: `    UNION ALL SELECT "student_qbo_id", 'student' FROM "volunteer_signup"`, by: "0027_volunteer_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "volunteer_credit"`, by: "0027_volunteer_app_ids_finish" },
  { line: `    UNION ALL SELECT "student_qbo_id", 'student' FROM "volunteer_credit"`, by: "0027_volunteer_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "volunteer_reminder"`, by: "0027_volunteer_app_ids_finish" },
  // The name hint a sign-up's student gave: the sign-up names its student's record now, which keeps the name it has.
  { line: `    UNION ALL SELECT "student_qbo_id", "filler_name", 3, "created_at", "id" FROM "volunteer_signup" WHERE "student_qbo_id" IS NOT NULL AND btrim("filler_name") <> ''`, by: "0027_volunteer_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "signature_request"`, by: "0029_forms_app_ids_finish" },
  { line: `    UNION ALL SELECT s."subject_qbo_id", r."applies_to" FROM "signature_request" s JOIN "requirement" r ON r."id" = s."requirement_id"`, by: "0029_forms_app_ids_finish" },
  // The current company's evidence names its records by id since 0028; its QuickBooks ids are the record's own copies.
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "signed_form_evidence" WHERE "earlier_company_at" IS NULL AND "realm_id" = (SELECT realm_id FROM app_fill_source)`, by: "0028_forms_app_ids_additive" },
  { line: `    UNION ALL SELECT "subject_qbo_id", "subject_kind" FROM "signed_form_evidence" WHERE "earlier_company_at" IS NULL AND "realm_id" = (SELECT realm_id FROM app_fill_source)`, by: "0028_forms_app_ids_additive" },
  // The name hint a request's subject gave: the request names its record now, which keeps the name it has.
  { line: `    UNION ALL SELECT "subject_qbo_id", "subject_name", 2, "updated_at", "id" FROM "signature_request" WHERE btrim("subject_name") <> ''`, by: "0029_forms_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "buyout" WHERE "realm_id" = (SELECT realm_id FROM app_fill_source)`, by: "0031_buyouts_app_ids_finish" },
  { line: `    UNION ALL SELECT b."subject_qbo_id", r."applies_to" FROM "buyout" b JOIN "requirement" r ON r."id" = b."requirement_id" WHERE b."realm_id" = (SELECT realm_id FROM app_fill_source)`, by: "0031_buyouts_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "family_money" WHERE "realm_id" IS NULL OR "realm_id" = (SELECT realm_id FROM app_fill_source)`, by: "0033_family_money_app_ids_finish" },
  // The write queue's items name the records they are filed under by id since 0034; their targets stay what is sent,
  // and the target's read spans two lines of 0023, each taken out.
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "write_queue" WHERE "realm_id" = (SELECT realm_id FROM app_fill_source)`, by: "0035_write_queue_app_ids_finish" },
  { line: `    UNION ALL SELECT "target_qbo_id", CASE WHEN "request"->>'role' = 'student' THEN 'student' ELSE 'family' END FROM "write_queue"`, by: "0034_write_queue_app_ids_additive" },
  { line: `      WHERE "realm_id" = (SELECT realm_id FROM app_fill_source) AND "request"->>'op' IN ('rename', 'move', 'deactivate') AND "request"->>'role' IN ('family', 'member', 'student')`, by: "0034_write_queue_app_ids_additive" },
  // A parent's session and a pending change of sign-in address name the family they chose, or were asked in, by its
  // record's id since 0037; 0038 dropped the QuickBooks columns.
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "parent_email_change"`, by: "0038_sessions_app_ids_finish" },
  { line: `    UNION ALL SELECT "family_qbo_id", 'family' FROM "parent_auth_session"`, by: "0038_sessions_app_ids_finish" },
];

/**
 * The statements from the fill's begin marker to its end marker, and the last one, which drops its scratch tables, with
 * the lines of RE_KEYED_SINCE_0023 taken out. The carry-over's audit row is left out: it belongs to the migration's own
 * run. Run them in order on one connection (a transaction): the scratch tables are that session's.
 */
export function appRecordsFillStatements(): string[] {
  let text = readFileSync(path.resolve(FILL_MIGRATION), "utf8").replaceAll("\r\n", "\n");
  for (const { line, by } of RE_KEYED_SINCE_0023) {
    // Each line once, as written: a fill that no longer reads as it did fails here, rather than running half changed.
    if (text.split(`${line}\n`).length !== 2) throw new Error(`${FILL_MIGRATION} no longer holds, once, the line ${by} made stale: ${line.trim()}`);
    text = text.replace(`${line}\n`, "");
  }
  const chunks = text.split("--> statement-breakpoint").map((c) => c.trim()).filter(Boolean);
  const begin = chunks.findIndex((c) => c.includes("app-records fill: begin"));
  const end = chunks.findIndex((c) => c.includes("app-records fill: end"));
  const drop = chunks.at(-1) ?? "";
  if (begin < 0 || end <= begin || !drop.startsWith("DROP TABLE pg_temp.app_fill_source")) {
    throw new Error(`${FILL_MIGRATION} no longer has the app-records fill between its begin and end markers, followed by the drop of its scratch tables.`);
  }
  return [...chunks.slice(begin, end), drop];
}
