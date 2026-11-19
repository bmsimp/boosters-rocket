import { createHash } from "node:crypto";
import postgres from "postgres";
import { createSecretBox } from "../src/lib/crypto/secret-box";
import { mailConfigHash } from "../src/lib/mail/config-hash";
import { runMigrations } from "../src/lib/db/migrate";
import { assertE2eDatabase, e2eMailPort } from "../tests/e2e/run-config";
import { E2E_VOLUNTEER } from "../tests/e2e/volunteer-seed";
import { E2E_BUYOUT } from "../tests/e2e/buyout-seed";
import { E2E_SIGNED_PDF } from "../tests/e2e/signed-forms-seed";
import { E2E_EMAIL, emailTokenHash } from "../tests/e2e/email-seed";
import { appRecordsFillStatements } from "../tests/helpers/app-records-fill";

/**
 * This script empties the database and seeds it again: test databases only, and in a git worktree never the database
 * every tree shares (tests/e2e/run-config.ts).
 */
function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "";
  try { assertE2eDatabase(url); } catch (e) {
    console.error(`seed-e2e refuses to run: DATABASE_URL names a database this script must not touch. It deletes and overwrites data.
${(e as Error).message}`);
    process.exit(2);
  }
  return url;
}

async function main() {
  const url = testDatabaseUrl(), mailPort = e2eMailPort();
  // Migrated here, after the check, so a worktree's migrations only ever reach the database the check let through.
  await runMigrations(url);
  const sql = postgres(url);
  // Start from nothing, as vitest's resetDb() does: every table but the built-in roles the migrations make. A vitest
  // run on this database leaves its own people and settings behind, and the specs count what the pages list.
  const tables = (await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'role'`).map((r) => r.tablename as string);
  await sql.unsafe(`TRUNCATE ${tables.map((t) => `"${t.replaceAll('"', '""')}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await sql`DELETE FROM role WHERE builtin = false`;
  const [p] = await sql`INSERT INTO parent (name, email) VALUES ('Zelda Quetzalcoatl', 'zelda@example.com')
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  await sql`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id)
          VALUES (${crypto.randomUUID()}, 'Zelda Quetzalcoatl', 'zelda@example.com', true, ${p!.id}) ON CONFLICT (parent_id) DO NOTHING`;
  // Each link names the QuickBooks record it came from (E2E-P1, E2E-P2 below), as the reconcile leaves it once parent
  // sign-ins are switched on (tests/e2e/parents.spec.ts): "Your details" then offers "Update my details" in both passes
  // of the run. Those ids are not numbers on purpose. The edit page reads a parent's record from QuickBooks as it
  // opens, and an id that isn't digits is never sent: with the made-up tokens below, a number here would send this
  // run's requests to Intuit's real servers (tests/e2e/family-details.spec.ts checks the id before it opens the page).
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status, source_qbo_id) VALUES ('E2E-FAMILY', ${p!.id}, true, 'active', 'E2E-P1')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status, source_qbo_id) VALUES ('E2E-FAMILY-2', ${p!.id}, false, 'active', 'E2E-P2')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
  // A live session for Zelda with the first family chosen, so the e2e run can open parent pages without the emailed
  // code (tests/e2e/parent-session.ts makes the cookie). Every session she has is deleted first, as the staff one is.
  const [zelda] = await sql`SELECT id FROM parent_auth_user WHERE parent_id = ${p!.id}`;
  await sql`DELETE FROM parent_auth_session WHERE user_id = ${zelda!.id}`;
  await sql`INSERT INTO parent_auth_session (id, token, user_id, family_qbo_id, expires_at)
          VALUES ('e2e-parent-session', 'e2e-parent-session-token', ${zelda!.id}, 'E2E-FAMILY', now() + interval '7 days')`;
  // SMTP to the e2e mail sink (tests/e2e/parent-sign-in.spec.ts), counted as tested.
  const sealed = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! }).seal("sink-password", "mail:smtp-password");
  const mail = { method: "smtp", host: "127.0.0.1", port: mailPort, security: "tls", username: "sender", from: "boosters@e2e.example.org",
    passwordCiphertext: sealed.ciphertext, passwordKeyId: sealed.keyId } as const;
  const status = { verifiedHash: mailConfigHash(mail), verifiedAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: null, lastError: null };
  await sql`INSERT INTO setting (key, value) VALUES ('mail', ${sql.json(mail)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO setting (key, value) VALUES ('mail.status', ${sql.json(status)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
  await sql`INSERT INTO setting (key, value) VALUES ('club', ${sql.json({ name: "E2E Boosters", shortName: "E2E", color: "#5b2a86", treasurerEmail: null })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO setting (key, value) VALUES ('setup.state', ${sql.json({ status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

  // An Admin with a live staff session, so the e2e run can open staff pages (tests/e2e/staff-session.ts makes the cookie).
  // resolveStaff finds the staff_user by auth_user_id and needs it active; the Admin role gives every permission.
  const [staff] = await sql`INSERT INTO staff_user (email, name, status) VALUES ('e2e-admin@example.org', 'E2E Admin', 'active')
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = 'active' RETURNING id`;
  const authUserId = "e2e-staff-auth-user";
  await sql`INSERT INTO staff_auth_user (id, name, email, email_verified) VALUES (${authUserId}, 'E2E Admin', 'e2e-admin@example.org', true) ON CONFLICT (id) DO NOTHING`;
  await sql`UPDATE staff_user SET auth_user_id = ${authUserId} WHERE id = ${staff!.id}`;
  await sql`INSERT INTO role_assignment (role_id, staff_user_id) SELECT id, ${staff!.id} FROM role WHERE key = 'admin' ON CONFLICT DO NOTHING`;
  await sql`DELETE FROM staff_auth_session WHERE user_id = ${authUserId}`;
  await sql`INSERT INTO staff_auth_session (id, token, user_id, expires_at) VALUES ('e2e-staff-session', 'e2e-staff-session-token', ${authUserId}, now() + interval '7 days')`;

  // QuickBooks as if an Admin had connected a sandbox company. The tokens are made up and never used: nothing in the e2e run reaches Intuit.
  const box = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! });
  const secret = box.seal("e2e-client-secret", "qbo:client-secret"), access = box.seal("e2e-access", "qbo:access-token"), refresh = box.seal("e2e-refresh", "qbo:refresh-token");
  await sql`DELETE FROM qbo_connection`;
  await sql`INSERT INTO qbo_connection (environment, client_id, client_secret_ciphertext, client_secret_key_id, realm_id, company_name,
            access_token_ciphertext, access_token_key_id, access_expires_at, refresh_token_ciphertext, refresh_token_key_id, refresh_expires_at, connected_at, last_token_refresh_at)
          VALUES ('sandbox', 'e2e-client-id-1234567890', ${secret.ciphertext}, ${secret.keyId}, '9130000000000001', 'E2E Sandbox Company',
            ${access.ciphertext}, ${access.keyId}, now() + interval '5 years', ${refresh.ciphertext}, ${refresh.keyId}, now() + interval '5 years', now(), now())`;
  await sql`DELETE FROM qbo_customer_type`;
  await sql`DELETE FROM qbo_customer`;
  // No id in this roster is a number, a customer type's included, on purpose: QuickBooks is asked about, or sent, only an
  // id that is digits (isQboId in src/lib/quickbooks/client.ts), and this run's QuickBooks connection holds made-up
  // tokens. A staff change made in the browser run (tests/e2e/roster-writes.spec.ts) names a customer, or a customer
  // type and a family, so with these ids every one is refused before anything is sent to Intuit. The run checks it
  // (tests/e2e/family-details.spec.ts).
  await sql`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('E2E-T1','Family',true), ('E2E-T2','Parent',true), ('E2E-T3','Student',true), ('E2E-T4','School',true)`;
  await sql`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, email, phone, sync_token) VALUES
          ('E2E-10', 'Rivera Family', true, null, 'E2E-T1', null, null, '0'),
          ('E2E-11', 'Ana Rivera', true, 'E2E-10', 'E2E-T2', 'ana@example.com', '555-0101', '0'),
          ('E2E-12', 'Leo Rivera', true, 'E2E-10', 'E2E-T3', null, null, '0'),
          ('E2E-20', '<img src=x onerror=alert(1)> Family', true, null, 'E2E-T1', null, null, '0'),
          ('E2E-30', 'Lincoln High', true, null, 'E2E-T4', null, null, '0'),
          ('E2E-FAMILY', 'Quetzalcoatl Family', true, null, 'E2E-T1', null, null, '0'),
          ('E2E-P1', 'Zelda Quetzalcoatl', true, 'E2E-FAMILY', 'E2E-T2', 'zelda@example.com', null, '0'),
          ('E2E-S1', 'Xochitl Quetzalcoatl', true, 'E2E-FAMILY', 'E2E-T3', null, null, '0'),
          ('E2E-S2', 'Yaretzi Quetzalcoatl', true, 'E2E-FAMILY', 'E2E-T3', null, null, '0'),
          ('E2E-FAMILY-2', 'Second Family', true, null, 'E2E-T1', null, null, '0'),
          ('E2E-P2', 'Zelda Quetzalcoatl', true, 'E2E-FAMILY-2', 'E2E-T2', 'zelda@example.com', null, '0'),
          ('E2E-S3', 'Wolfgang Secondborn', true, 'E2E-FAMILY-2', 'E2E-T3', null, null, '0'),
          ('E2E-40', 'Okafor Family', true, null, 'E2E-T1', null, null, '0'),
          ('E2E-41', 'Sam Okafor', true, 'E2E-40', 'E2E-T2', 'sam@example.com', null, '0'),
          ('E2E-50', 'Lee Family', true, null, 'E2E-T1', null, null, '0'),
          ('E2E-51', 'Sam Okafor', true, 'E2E-50', 'E2E-T2', 'sam@example.com', null, '0')`;
  // Zelda is in two families on purpose (the family chooser test), so staff have already said she is one person.
  // Sam's address is under two families and waits for a decision (tests/e2e/parents.spec.ts decides and reverses it).
  // The parents setting is cleared here and nowhere else: tests/e2e/parents.spec.ts switches sign-ins on, and that
  // state must survive the second (desktop) pass of the run.
  await sql`INSERT INTO held_address (email, approved_family_qbo_ids) VALUES ('zelda@example.com', ${sql.json(["E2E-FAMILY", "E2E-FAMILY-2"])})
          ON CONFLICT (email) DO UPDATE SET approved_family_qbo_ids = EXCLUDED.approved_family_qbo_ids`;
  await sql`DELETE FROM held_address WHERE email = 'sam@example.com'`;
  await sql`DELETE FROM setting WHERE key IN ('parents.settings', 'parents.review_notice', 'parents.previous_company')`;
  await sql`INSERT INTO setting (key, value) VALUES ('membership.shape', ${sql.json({ kind: "layered", familyTypeId: "E2E-T1", studentTypeId: "E2E-T3", parentTypeId: "E2E-T2" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  // The cache says which company it came from, as a real refresh records it; without this the pages treat it as unread.
  await sql`INSERT INTO setting (key, value) VALUES ('roster.source', ${sql.json({ realmId: "9130000000000001" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  // What each of Zelda's two families owes, as figures QuickBooks has just given: an invoice with a pay link, one
  // without, and one paid. The freshness window is set to a week so the rows stay fresh for the whole run: a page load
  // that found them stale would ask Intuit's real servers, with the made-up tokens above. Dates are counted from today
  // so the due words ("in 8 days", "Was due") come out the same whenever the run is.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  // Each invoice names the customer it was raised on (the family itself, or a student under it in the cache above): a
  // stored invoice of a customer who is not the family's is not shown.
  // `items` are the QuickBooks products and services its lines carry: what a payment requirement is met by.
  const invoice = (qboId: string, number: string, customerQboId: string, forName: string | null, cents: number, o: { due?: number; paid?: boolean; payLink?: string; items?: string[] } = {}) => ({
    qboId, number, customerQboId, forName, date: day(-30), dueDate: o.due === undefined ? null : day(o.due), totalCents: cents, balanceCents: o.paid ? 0 : cents, currency: "USD", payLink: o.payLink ?? null,
    itemQboIds: o.items ?? [] });
  const BAND_FEE_ITEM = "4101";
  const HELP_ITEM = "4102"; // what a volunteer buy-out is billed with (v1 spec §11.5)
  const families = [
    { id: "E2E-FAMILY", total: 18500, invoices: [
      // QZ-1042 is the invoice of the family's volunteer buy-out ("Concession help", below), made by the portal.
      invoice("902", "QZ-1042", "E2E-FAMILY", null, 10000, { due: -20, items: [HELP_ITEM] }), // soonest due first, as a read from QuickBooks stores them
      invoice("901", "QZ-1041", "E2E-S1", "Xochitl Quetzalcoatl", 8500, { due: 8, payLink: "https://connect.intuit.com/t/scs-v1-e2e-quetzalcoatl-1041" }),
      invoice("903", "QZ-1017", "E2E-FAMILY", null, 15000, { paid: true, items: [BAND_FEE_ITEM] }) ] }, // the band fee, paid
    { id: "E2E-FAMILY-2", total: 37666, invoices: [
      invoice("911", "SF-2051", "E2E-S3", "Wolfgang Secondborn", 31247, { due: 8, payLink: "https://connect.intuit.com/t/scs-v1-e2e-second-2051" }),
      invoice("912", "SF-2052", "E2E-FAMILY-2", null, 6419, { due: 40 }),
      invoice("913", "SF-2009", "E2E-FAMILY-2", null, 27358, { paid: true }) ] },
  ];
  await sql`INSERT INTO setting (key, value) VALUES ('money.settings', ${sql.json({ freshSeconds: 7 * 86_400 })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`DELETE FROM family_money`;
  // The worker's last check of each customer's balance in QuickBooks (src/lib/money/sweep.ts): the second family's
  // student owes $50.00 more there than his open invoices, so staff see the family under "Worth a look"
  // (tests/e2e/balances.spec.ts). Its amount is in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts).
  const checks = [
    { customerQboId: "E2E-FAMILY-2", name: null, balanceCents: 6419, invoicesCents: 6419, currency: "USD" },
    { customerQboId: "E2E-P2", name: "Zelda Quetzalcoatl", balanceCents: 0, invoicesCents: 0, currency: "USD" },
    { customerQboId: "E2E-S3", name: "Wolfgang Secondborn", balanceCents: 36247, invoicesCents: 31247, currency: "USD" },
  ];
  // Each family's figures are kept by the app's own family (migration 0032): stored below, once 0023's fill has made
  // the records, with the invoices and the check each naming their customers as before.
  const storeMoney = async (tx: postgres.TransactionSql, familyOf: (customer: string) => Promise<string>) => {
    for (const f of families) {
      await tx`INSERT INTO family_money (family_id, realm_id, read_at, invoices, total_cents, balance_with_jobs_cents, currency)
              VALUES (${await familyOf(f.id)}, '9130000000000001', now(), ${tx.json(f.invoices)}, ${f.total}, ${f.total}, 'USD')`;
    }
    await tx`UPDATE family_money SET checked_at = now(), customer_checks = ${tx.json(checks)} WHERE family_id = ${await familyOf("E2E-FAMILY-2")}`;
  };
  await sql`DELETE FROM setting WHERE key = 'money.run'`;
  // The club's current season (v1 spec §10): four steps with no dates, so each family is on the first step it hasn't
  // finished. The Quetzalcoatl family has done Join; in Uniforms, Xochitl has been ticked off and Yaretzi has not
  // (tests/e2e/season.spec.ts ticks her, and unticks her again). Two requirements are asked of other families alone,
  // one with a waiver: their titles and the reason are in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts).
  const [fall] = await sql`INSERT INTO season (name, is_current) VALUES ('Fall 2026', true) RETURNING id`;
  const stepIds: Record<string, string> = {};
  for (const [position, name] of ["Join", "Uniforms", "Season", "Wrap-up"].entries()) {
    const [step] = await sql`INSERT INTO season_step (season_id, name, position) VALUES (${fall!.id}, ${name}, ${position}) RETURNING id`;
    stepIds[name] = step!.id as string;
  }
  type SeedRequirement = { step: string; title: string; appliesTo: "family" | "student"; required?: boolean; due?: number; chosen?: string[]; ticked?: string[]; waived?: Record<string, string>; item?: string };
  // The chosen lists, ticks and waivers name the app's own families and students (stage 2 of the app-owned families
  // spec), which the fill at the end makes: they are kept here, by QuickBooks id, and stored once the fill has run.
  type SeasonRow = { table: "cover" | "progress"; requirementId: string; kind: "family" | "student"; customer: string; ticked?: boolean; reason?: string };
  const seasonRows: SeasonRow[] = [];
  const requirements: SeedRequirement[] = [
    { step: "Join", title: "Handbook read", appliesTo: "family", ticked: ["E2E-FAMILY", "E2E-10"] },
    { step: "Join", title: "Tuba locker key returned", appliesTo: "family", chosen: ["E2E-10"] },
    { step: "Uniforms", title: "Uniform fitting attended", appliesTo: "student", ticked: ["E2E-S1", "E2E-12"] },
    { step: "Uniforms", title: "Marching shoes sized", appliesTo: "student", required: false },
    { step: "Uniforms", title: "Percussion truck crew sign-off", appliesTo: "student", chosen: ["E2E-S3"], waived: { "E2E-S3": "Cast on his arm until December" } },
    { step: "Wrap-up", title: "Banquet RSVP", appliesTo: "family", due: 30 },
    // A payment, met by the band fee on the Quetzalcoatl family's paid invoice: it reads "Paid" (tests/e2e/balances.spec.ts).
    { step: "Wrap-up", title: "Band fee", appliesTo: "family", required: false, item: BAND_FEE_ITEM },
  ];
  for (const [position, r] of requirements.entries()) {
    const [row] = await sql`INSERT INTO requirement (step_id, kind, item_qbo_id, title, required, applies_to, due_on, covers, position)
            VALUES (${stepIds[r.step]!}, ${r.item ? "payment" : "checklist"}, ${r.item ?? null}, ${r.title}, ${r.required ?? true}, ${r.appliesTo}, ${r.due === undefined ? null : day(r.due)}, ${r.chosen ? "chosen" : "everyone"}, ${position}) RETURNING id`;
    for (const customer of r.chosen ?? []) seasonRows.push({ table: "cover", requirementId: row!.id as string, kind: r.appliesTo, customer });
    for (const customer of r.ticked ?? []) seasonRows.push({ table: "progress", requirementId: row!.id as string, kind: r.appliesTo, customer, ticked: true });
    for (const [customer, reason] of Object.entries(r.waived ?? {})) seasonRows.push({ table: "progress", requirementId: row!.id as string, kind: r.appliesTo, customer, reason });
  }
  // Volunteer buy-outs (v1 spec §11.5): three optional volunteer requirements in Wrap-up that offer paying instead,
  // with fixed ids (tests/e2e/buyout-seed.ts). The Quetzalcoatl family has chosen a buy-out of "Concession help" and
  // its invoice (QZ-1042, above) is on Payments; "Pit crew hours" is offered to it; "Rivera trailer shifts" is asked of
  // the Rivera family alone (its title is in OTHER_FAMILIES, tests/e2e/parent-session.spec.ts). No shift counts toward
  // any of them, so no shift's words change.
  const buyoutRequirements = [
    { id: E2E_BUYOUT.offered, title: "Pit crew hours", amount: 2, unit: "hours", unitCents: 1250, chosen: null },
    { id: E2E_BUYOUT.invoiced, title: "Concession help", amount: 2, unit: "shifts", unitCents: 5000, chosen: null },
    { id: E2E_BUYOUT.other, title: "Rivera trailer shifts", amount: 1, unit: "shifts", unitCents: 2000, chosen: "E2E-10" },
  ];
  for (const [i, r] of buyoutRequirements.entries()) {
    await sql`INSERT INTO requirement (id, step_id, kind, title, required, applies_to, amount, amount_unit, covers, position, item_qbo_id, buyout_unit_cents)
            VALUES (${r.id}, ${stepIds["Wrap-up"]!}, 'volunteer', ${r.title}, false, 'family', ${r.amount}, ${r.unit}, ${r.chosen ? "chosen" : "everyone"}, ${requirements.length + i}, ${HELP_ITEM}, ${r.unitCents})`;
    if (r.chosen) seasonRows.push({ table: "cover", requirementId: r.id, kind: "family", customer: r.chosen });
  }
  // The buy-outs name the app's own family (stage 2 of the app-owned families spec), which the fill at the end makes:
  // stored once it has run, as migration 0030 stores them. Both requirements are per-family, so neither names a student.
  // The Rivera family's buy-out of its trailer shifts, which QuickBooks refused: on Reconciliation for staff to close
  // (tests/e2e/buyout-close.spec.ts). Refused, it holds no live place, so the Rivera family's choice is as it was.
  const zeldaParent = p!.id as string, riveraGuardian = crypto.randomUUID();
  const storeBuyouts = async (tx: postgres.TransactionSql, familyOf: (customer: string) => Promise<string>) => {
    await tx`INSERT INTO buyout (id, requirement_id, family_id, student_id, customer_qbo_id, item_qbo_id, unit_cents, units, amount_cents, state, invoice_qbo_id, invoice_sync_token, realm_id, chosen_by, chosen_by_label)
            VALUES (${E2E_BUYOUT.buyout}, ${E2E_BUYOUT.invoiced}, ${await familyOf("E2E-FAMILY")}, null, 'E2E-FAMILY', ${HELP_ITEM}, 5000, 2, 10000, 'invoiced', '902', '0', '9130000000000001', ${zeldaParent}, 'zelda@example.com')`;
    await tx`INSERT INTO buyout (id, requirement_id, family_id, student_id, customer_qbo_id, item_qbo_id, unit_cents, units, amount_cents, state, last_code, realm_id, chosen_by, chosen_by_label)
            VALUES (${E2E_BUYOUT.refused}, ${E2E_BUYOUT.other}, ${await familyOf("E2E-10")}, null, 'E2E-10', ${HELP_ITEM}, 2000, 1, 2000, 'refused', 'fault_6000', '9130000000000001', ${riveraGuardian}, 'a guardian')`;
  };
  // Volunteering (v1 spec §11): one event 20 days ahead with two shifts, their ids fixed so the specs can ask for them
  // (tests/e2e/volunteer.spec.ts, PARAMS in tests/e2e/parent-session.spec.ts). The Rivera family has signed Leo up for
  // the griddle, so the Quetzalcoatl family sees "1 of 4 places filled" and never who. The volunteer spec signs Zelda up
  // and cancels again, so both passes of the run find the same count.
  await sql`INSERT INTO volunteer_event (id, name, on_date, location, description, contact_name, contact_email)
          VALUES (${E2E_VOLUNTEER.event}, 'Pancake breakfast', ${day(20)}, 'School cafeteria', 'Flipping pancakes before the spring concert.', 'Pat Organizer', 'pat@e2e.example.org')`;
  await sql`INSERT INTO volunteer_shift (id, event_id, starts_at, ends_at, places, role, checkin_code) VALUES
          (${E2E_VOLUNTEER.griddle}, ${E2E_VOLUNTEER.event}, '07:00', '09:00', 4, 'Griddle', ${E2E_VOLUNTEER.griddleCode}),
          (${E2E_VOLUNTEER.cleanup}, ${E2E_VOLUNTEER.event}, '09:00', '11:00', 2, 'Cleanup', DEFAULT)`;
  // The sign-ups name the app's own family and student (stage 2 of the app-owned families spec), which the fill at the
  // end makes: kept here by QuickBooks id, and stored once the fill has run, as migration 0026 stores them.
  type SignupRow = { shiftId: string; family: string; signedUpBy: string; student: string | null; fillerParentId: string | null; fillerName: string };
  const signupRows: SignupRow[] = [
    { shiftId: E2E_VOLUNTEER.griddle, family: "E2E-10", signedUpBy: crypto.randomUUID(), student: "E2E-12", fillerParentId: null, fillerName: "Leo Rivera" },
  ];
  // Checking in (v1 spec §11.4, tests/e2e/check-in.spec.ts): a shift whose window is open whenever the browser run
  // happens, worked out from the club's clock (UTC here) now, and one that is over. Zelda has a place on each; the
  // spec checks her in on the first, and passes whether she is checked in already or not, as both passes of a run read
  // this one seed. The closed one ended yesterday, so neither is in the Volunteer spec's list of places still to come
  // but the open one, which can no longer be cancelled.
  const clock = (d: Date) => d.toISOString().slice(11, 16);
  const opened = new Date(Date.now() - 60 * 60_000), closes = new Date(Date.now() + 4 * 60 * 60_000);
  await sql`INSERT INTO volunteer_event (id, name, on_date, location, contact_name) VALUES
          (${E2E_VOLUNTEER.openEvent}, 'Concession stand', ${opened.toISOString().slice(0, 10)}, 'Stadium gate', 'Pat Organizer'),
          (${E2E_VOLUNTEER.closedEvent}, 'Car wash', ${day(-1)}, 'Bandroom parking lot', 'Pat Organizer')`;
  await sql`INSERT INTO volunteer_shift (id, event_id, starts_at, ends_at, places, role, checkin_code) VALUES
          (${E2E_VOLUNTEER.openShift}, ${E2E_VOLUNTEER.openEvent}, ${clock(opened)}, ${clock(closes)}, 6, 'Popcorn', ${E2E_VOLUNTEER.openCode}),
          (${E2E_VOLUNTEER.closedShift}, ${E2E_VOLUNTEER.closedEvent}, '10:00', '11:00', 6, 'Rinse crew', ${E2E_VOLUNTEER.closedCode})`;
  for (const shiftId of [E2E_VOLUNTEER.openShift, E2E_VOLUNTEER.closedShift]) {
    signupRows.push({ shiftId, family: "E2E-FAMILY", signedUpBy: p!.id as string, student: null, fillerParentId: p!.id as string, fillerName: "Zelda Quetzalcoatl" });
  }

  // Forms (v1 spec §9). Forms are NOT set up: no Documenso address or token is stored, so nothing in the e2e run can
  // call a Documenso, and the pages show what is stored. Three optional form requirements in Join, which the
  // Quetzalcoatl family has finished: one asked of every family, with a signed form stored for the Quetzalcoatl family
  // and an unsigned one for Zelda's second family; one asked of each student, with no template yet; and one asked of
  // the second family alone (its title is in OTHER_FAMILIES, tests/e2e/parent-session.spec.ts). The two request ids
  // are fixed: that spec asks for /forms/<id> with each.
  const template = { templateId: "envelope_e2etemplate01", templateTitle: "E2E travel consent", templateUpdatedAt: "2026-11-01T12:00:00.000Z", signerRoles: 2, signers: "any", attachedAt: "2026-11-02T12:00:00.000Z" };
  const forms = [
    { title: "Travel consent", appliesTo: "family", form: template, chosen: null },
    { title: "Medical release", appliesTo: "student", form: null, chosen: null },
    { title: "Trailer towing agreement", appliesTo: "family", form: template, chosen: ["E2E-FAMILY-2"] },
  ];
  const formIds: Record<string, string> = {};
  for (const [at, f] of forms.entries()) {
    const [row] = await sql`INSERT INTO requirement (step_id, kind, title, required, applies_to, covers, position, form)
            VALUES (${stepIds.Join!}, 'form', ${f.title}, false, ${f.appliesTo}, ${f.chosen ? "chosen" : "everyone"}, ${100 + at}, ${f.form ? sql.json(f.form) : null}) RETURNING id`;
    formIds[f.title] = row!.id as string;
    for (const customer of f.chosen ?? []) seasonRows.push({ table: "cover", requirementId: row!.id as string, kind: f.appliesTo as "family" | "student", customer });
  }
  // The two requests and the kept evidence are stored once the app's records exist (after the fill below): they name the
  // app's own families, as migrations 0028 and 0029 store them.
  const zeldaSigned = [{ parentId: p!.id, recipientId: 1, name: "Zelda Quetzalcoatl", email: "zelda@example.com", signedAt: "2026-11-10T15:00:00.000Z" }];
  const secondWaiting = [{ parentId: crypto.randomUUID(), recipientId: 2, name: "Wilhelmina Secondborn", email: "wilhelmina@second.example", signedAt: null }];
  const storeForms = async (tx: postgres.TransactionSql, familyOf: (customer: string) => Promise<string>) => {
    const quetzalcoatl = await familyOf("E2E-FAMILY"), second = await familyOf("E2E-FAMILY-2");
    await tx`INSERT INTO signature_request (id, requirement_id, family_id, state, envelope_id, envelope_status, template_id, template_updated_at, signers_mode, subject_name, signers,
                document_created_at, checked_at, all_signed_at, completed_at, evidence_owed)
              VALUES ('e2e00000-0000-4000-8000-000000000001', ${formIds["Travel consent"]!}, ${quetzalcoatl}, 'complete', 'envelope_e2equetzalcoatl', 'COMPLETED', ${template.templateId}, ${template.templateUpdatedAt},
                'any', 'Quetzalcoatl Family', ${tx.json(zeldaSigned)}, now(), now(), now(), now(), false)`;
    // Its evidence, as the worker would have kept it (src/lib/signed-forms/evidence-job.ts), with made-up PDF bytes: the
    // staff matrix leads to it, and both the staff and the parent downloads send its sealed PDF
    // (tests/e2e/signed-forms.spec.ts, which reads E2E_SIGNED_PDF). Its copy counts as sent, so nothing is emailed. It
    // keeps the customers' ids as its own copies, beside the app's family.
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const files = [
      { kind: "sealed_pdf", itemId: "envelope_item_e2equetzalcoatl1", bytes: Buffer.from(E2E_SIGNED_PDF, "latin1") },
      { kind: "certificate_pdf", itemId: null, bytes: Buffer.from("%PDF-1.4\n% Booster Rocket e2e signing certificate\n%%EOF\n", "latin1") },
      { kind: "audit_log_pdf", itemId: null, bytes: Buffer.from("%PDF-1.4\n% Booster Rocket e2e audit log\n%%EOF\n", "latin1") },
      { kind: "audit_log_json", itemId: null, bytes: Buffer.from(JSON.stringify({ envelopeId: "envelope_e2equetzalcoatl", count: 1, entries: [{ type: "DOCUMENT_COMPLETED" }] })) },
    ];
    const [evidence] = await tx`INSERT INTO signed_form_evidence (request_id, realm_id, requirement_id, family_qbo_id, subject_qbo_id, subject_kind, family_id, form_title, family_name, subject_name, season_name,
                envelope_id, template_id, template_updated_at, signers, consents, originals, completed_at, copies_done_at)
              VALUES ('e2e00000-0000-4000-8000-000000000001', '9130000000000001', ${formIds["Travel consent"]!}, 'E2E-FAMILY', 'E2E-FAMILY', 'family', ${quetzalcoatl}, 'Travel consent', 'Quetzalcoatl Family',
                'Quetzalcoatl Family', 'Fall 2026', 'envelope_e2equetzalcoatl', ${template.templateId}, ${template.templateUpdatedAt}, ${tx.json(zeldaSigned.map((s) => ({ parentId: s.parentId, name: s.name, email: s.email, signedAt: s.signedAt })))},
                ${tx.json([{ parentId: p!.id, name: "Zelda Quetzalcoatl", email: "zelda@example.com", textVersion: "2026-11-16", agreedAt: "2026-11-10T14:58:00.000Z", ip: "203.0.113.50", userAgent: null }])},
                ${tx.json([{ itemId: "envelope_item_e2equetzalcoatl1", sha256: sha(Buffer.from("%PDF-1.4 original", "latin1")), size: 17 }])}, now(), now()) RETURNING id`;
    for (const f of files) {
      await tx`INSERT INTO signed_form_file (evidence_id, kind, position, item_id, bytes, size, sha256) VALUES (${evidence!.id}, ${f.kind}, 1, ${f.itemId}, ${f.bytes}, ${f.bytes.length}, ${sha(f.bytes)})`;
    }
    await tx`INSERT INTO signature_request (id, requirement_id, family_id, state, envelope_id, envelope_status, template_id, template_updated_at, signers_mode, subject_name, signers,
                document_created_at, checked_at)
              VALUES ('e2e00000-0000-4000-8000-000000000002', ${formIds["Travel consent"]!}, ${second}, 'waiting', 'envelope_e2esecondfamily', 'PENDING', ${template.templateId}, ${template.templateUpdatedAt},
                'any', 'Second Family', ${tx.json(secondWaiting)}, now(), now())`;
  };
  // A change of sign-in address Zelda asked for and hasn't confirmed, under her link to the Quetzalcoatl family, and a
  // used one under her link to the second family (tests/e2e/email-seed.ts: fixed tokens, so the specs can open them).
  // Their records' ids are not numbers: confirming is refused before anything is sent (tests/e2e/family-email.spec.ts).
  for (const [key, family, record, used] of [["own", "E2E-FAMILY", "E2E-P1", false], ["other", "E2E-FAMILY-2", "E2E-P2", true]] as const) {
    const [link] = await sql`SELECT id FROM guardian WHERE parent_id = ${p!.id} AND family_qbo_id = ${family}`;
    await sql`INSERT INTO parent_email_change (parent_id, guardian_id, family_qbo_id, record_qbo_id, new_email, token_hash, expires_at, used_at)
            VALUES (${p!.id}, ${link!.id}, ${family}, ${record}, ${E2E_EMAIL[key].newEmail}, ${emailTokenHash(E2E_EMAIL[key].token)}, now() + interval '7 days', ${used ? new Date() : null})`;
  }
  await sql`DELETE FROM write_queue`;
  await sql`DELETE FROM job_run`;
  await sql`INSERT INTO job_run (job, started_at, finished_at, outcome, detail, started_by) VALUES ('roster.refresh', now(), now(), 'ok', '16 customers, 4 customer types', 'worker')`;
  // The app's own families, students and links for every family above (stage 1 of the app-owned families spec), as a
  // roster read leaves them: made by migration 0023's fill, which tests/integration/app-records-fill.test.ts proves makes
  // what the portal's keepAppRecordsInStep() makes. One connection: its scratch tables are the session's.
  const fill = appRecordsFillStatements();
  await sql.begin(async (tx) => { for (const statement of fill) await tx.unsafe(statement); });
  // The season's chosen lists, ticks and waivers, the volunteer sign-ups, the form requests and evidence, the buy-outs and
  // each family's stored figures, by the app's own record of each customer, of the kind each names it as, in the roster's
  // company: as migrations 0024, 0026, 0028, 0030 and 0032 store them. A customer with no such record stops the seed.
  await sql.begin(async (tx) => {
    const recordOf = async (kind: "family" | "student", customer: string, what: string): Promise<string> => {
      const [link] = kind === "family"
        ? await tx`SELECT family_id AS id FROM accounting_link WHERE system = 'quickbooks' AND realm_id = '9130000000000001' AND customer_id = ${customer} AND family_id IS NOT NULL`
        : await tx`SELECT student_id AS id FROM accounting_link WHERE system = 'quickbooks' AND realm_id = '9130000000000001' AND customer_id = ${customer} AND student_id IS NOT NULL`;
      if (!link) throw new Error(`seed-e2e: no ${kind} record of ${customer} for ${what}`);
      return link.id as string;
    };
    for (const r of seasonRows) {
      const id = await recordOf(r.kind, r.customer, `the season's ${r.table === "cover" ? "chosen list" : "tick or waiver"}`);
      const family = r.kind === "family" ? id : null, student = r.kind === "student" ? id : null;
      if (r.table === "cover") await tx`INSERT INTO requirement_cover (requirement_id, family_id, student_id) VALUES (${r.requirementId}, ${family}, ${student})`;
      else await tx`INSERT INTO requirement_progress (requirement_id, family_id, student_id, met_at, waived_at, waived_reason)
              VALUES (${r.requirementId}, ${family}, ${student}, ${r.ticked ? new Date() : null}, ${r.reason ? new Date() : null}, ${r.reason ?? null})`;
    }
    for (const r of signupRows) {
      const family = await recordOf("family", r.family, "a volunteer sign-up");
      const student = r.student === null ? null : await recordOf("student", r.student, "a volunteer sign-up");
      await tx`INSERT INTO volunteer_signup (shift_id, family_id, signed_up_by, filler_kind, filler_parent_id, student_id, filler_name)
              VALUES (${r.shiftId}, ${family}, ${r.signedUpBy}, ${student === null ? "guardian" : "student"}, ${r.fillerParentId}, ${student}, ${r.fillerName})`;
    }
    await storeForms(tx, (customer) => recordOf("family", customer, "a form request"));
    await storeBuyouts(tx, (customer) => recordOf("family", customer, "a buy-out"));
    await storeMoney(tx, (customer) => recordOf("family", customer, "a family's stored figures"));
    // Staff roster changes waiting to reach QuickBooks, for the Reconciliation page (tests/e2e/roster-writes.spec.ts):
    // one waiting, one stuck, each filed under its family's record, as migration 0034 files them (a parent's change
    // names no student). The worker never runs in this run, and their ids are not numbers, so nothing is ever sent.
    await tx`INSERT INTO write_queue (realm_id, request, target_qbo_id, family_id, state, sent, tries, last_code, last_tried_at, next_try_at, asked_by_label, created_at) VALUES
            ('9130000000000001', ${tx.json({ op: "rename", role: "parent", qboId: "E2E-41", syncToken: "0", name: "Samuel Okafor", was: "Sam Okafor" })}, 'E2E-41', ${await recordOf("family", "E2E-40", "a queued change")},
              'waiting', true, 2, 'timeout', now() - interval '3 minutes', now() + interval '2 minutes', 'e2e-admin@example.org', now() - interval '10 minutes'),
            ('9130000000000001', ${tx.json({ op: "create", role: "student", name: "Pat Lee", typeQboId: "E2E-T3", familyQboId: "E2E-50", email: null })}, null, ${await recordOf("family", "E2E-50", "a queued change")},
              'stuck', false, 8, 'http_429', now() - interval '1 hour', null, 'e2e-admin@example.org', now() - interval '20 hours')`;
  });
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
