import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, pageOutcome, renderPage } from "../helpers/signed-in";

// QuickBooks is the stub: nothing here can reach Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, buyout, family, jobRun, qboConnection, qboCustomerType, role, roleAssignment, roleRule, setting, writeQueue } from "@/lib/db/schema";
import HealthPage from "@/app/staff/(app)/health/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import QuickBooksSetupPage from "@/app/staff/(app)/settings/quickbooks/setup/page";
import { writeAudit } from "@/lib/audit/log";
import { QUICKBOOKS_USE, QUICKBOOKS_WRITE_ACTION } from "@/lib/quickbooks/what-it-does";
import { GET as liveness } from "@/app/api/health/route";
import { healthReport, BACKUP_OLD_MS, MONEY_OLD_MS, SIGNIN_ADDRESS_LOOKBACK_MS, SWEEP_FAILED, WORKER_LATE_MS, type HealthLine } from "@/lib/health/report";
import { env } from "@/env";
import { BACKUP_KEY } from "@/lib/health/backup";
import { BUILD_VERSION } from "@/lib/health/version";
import { runDueJobs, WAKE_KEY } from "@/lib/jobs/runner";
import { CLEANUP_JOB } from "@/lib/jobs/cleanup";
import { BUYOUT_CHECK_MARK, CHALLENGE_SWEEP_MARK, markJob, readMark, REMINDERS_MARK, WELCOME_MARK } from "@/lib/jobs/marks";
import { BUYOUT_CHECK_LATE_MS } from "@/lib/health/job-lines";
import { getMailStatus, patchMailStatus } from "@/lib/mail/settings";
import { ADMIN_ONLY } from "@/lib/permissions/registry";
import { noteApiOk } from "@/lib/forms/settings";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { DUE_REMINDERS_KEY } from "@/lib/seasons/due-reminders";
import { BREACH_MARK, markBreachCheck, readBreachMark } from "@/lib/parents/breach-mark";
import { resetDb, seedGuardianInFamily, seedParent, seedStaff, seedWorkingMail, untilALockIsAwaited } from "../helpers/db";
import { connectForms } from "../helpers/forms";
import { seedBuyout, seedBuyoutRequirement } from "../helpers/buyouts";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const put = (key: string, value: unknown) => db.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
const line = (lines: HealthLine[], key: HealthLine["key"]) => lines.find((l) => l.key === key)!;
const at = (l: HealthLine, label: string) => l.times.find((t) => t.label === label)?.at;
async function admin() { const s = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }); asStaff(s); return s; }

describe("the health page", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("is Admin only: the widest custom role is refused, and a visitor is sent to sign in", async () => {
    expect(ADMIN_ONLY).toContain("Admin.Health.Read");
    expect(await pageOutcome(HealthPage)).toEqual({ redirect: "/staff/sign-in" });
    const s = await seedStaff({ email: "wide@club.org" });
    const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
    await db.insert(roleRule).values([{ roleId: r!.id, kind: "include", pattern: "*" }, { roleId: r!.id, kind: "include", pattern: "Admin.*" }, { roleId: r!.id, kind: "include", pattern: "Admin.Health.Read" }]);
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    asStaff(s);
    expect(await pageOutcome(HealthPage)).toEqual({ redirect: "/refused" });
    expect((await db.select().from(auditLog)).filter((a) => a.action === "access.refused")).toMatchObject([{ actorId: s.id, permission: "Admin.Health.Read" }]);
  });

  it("on a portal that was just installed, says in plain words what isn't set up yet", async () => {
    await admin();
    const lines = await healthReport(NOW);
    expect(lines.map((l) => l.key)).toEqual(["database", "worker", "cleanup", "quickbooks", "money", "buyout_check", "mail", "volunteer_reminders", "forms", "parents", "breach_check", "due_reminders", "backup", "version"]);
    expect(line(lines, "forms")).toMatchObject({ state: "off", word: "Not set up" });
    expect(line(lines, "database")).toMatchObject({ state: "ok", word: "Working" });
    expect(line(lines, "worker")).toMatchObject({ state: "attention", times: [{ label: "Last woke", at: null }] });
    expect(line(lines, "worker").says).toMatch(/has never checked in/);
    expect(line(lines, "cleanup")).toMatchObject({ state: "off", word: "Not yet run" });
    expect(line(lines, "quickbooks")).toMatchObject({ state: "off", word: "Not set up" });
    expect(line(lines, "money")).toMatchObject({ state: "off", word: "Not running" });
    expect(line(lines, "mail")).toMatchObject({ state: "attention", word: "Not set up" });
    expect(line(lines, "parents")).toMatchObject({ state: "off", word: "Off" });
    expect(line(lines, "breach_check")).toMatchObject({ state: "off", word: "Not used yet", times: [{ label: "Last answered", at: null }, { label: "Last failed", at: null }] });
    expect(line(lines, "due_reminders")).toMatchObject({ state: "off", word: "Off", fix: { href: "/staff/settings/parents" } });
    expect(line(lines, "backup")).toMatchObject({ state: "attention", word: "None recorded" });
    expect(line(lines, "backup").says).toMatch(/scripts\/backup\.sh/);
    expect(line(lines, "version").says).toBe(`Running ${BUILD_VERSION}.`);

    const html = await renderPage(HealthPage);
    expect(html).toContain("3 things need attention.");
    expect(html).toContain("The worker has never checked in.");
    expect(html).toContain("Last woke: never");
    expect(html).toContain(`Running ${BUILD_VERSION}.`);
    // The address the portal believes it has, as text. The browser adds whether it was reached there (tests/e2e/health.spec.ts).
    expect(html).toContain("This portal&#x27;s address is <code>http://localhost:3000</code>");
    for (const secret of [process.env.BETTER_AUTH_SECRET!, process.env.SETTINGS_ENCRYPTION_KEY!, "postgres://"]) expect(html).not.toContain(secret);
  });

  it("when everything works, says so, with when each part last worked", async () => {
    await admin();
    await seedConnected(stub);
    await seedWorkingMail();
    await patchMailStatus({ lastSuccessAt: ago(60_000) });
    // Welcome emails on too, which the reminders before a due date need (their line is off without them).
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    await put(BACKUP_KEY, { at: ago(3_600_000), file: "booster-rocket-20261115T030000Z.dump", bytes: 3 * 1024 * 1024 });
    // Forms set up, and Documenso answered a call (tests/integration/forms-staff.test.ts has the line's other states).
    await connectForms({ origin: "https://sign.club.example", token: "api_made_up_for_the_health_page" });
    await noteApiOk();
    // The read of every family's invoices needs a membership shape, which this company has none of: one is recorded as
    // done, and the wake's check of the buy-out invoices follows it.
    await db.insert(jobRun).values({ job: MONEY_JOB, finishedAt: new Date(), outcome: "ok", startedBy: "worker" });
    await runDueJobs(); // a wake: the clean-up, the token refresh, the roster read, the volunteer reminders and the buy-out check all run
    // A parent chose a password and the breach service answered (tests/integration/password-links.test.ts asks it for real).
    await markBreachCheck({ outcome: "not_found" });
    const lines = await healthReport();
    for (const l of lines) expect(l.state, `${l.key}: ${l.says} ${l.notes.join(" ")}`).toBe("ok");
    expect(line(lines, "worker").says).toBe("Waking every minute to run the scheduled jobs.");
    expect(Date.parse(at(line(lines, "worker"), "Last woke")!)).toBeGreaterThan(Date.now() - 60_000);
    expect(line(lines, "cleanup")).toMatchObject({ word: "Working", notes: ["Nothing to remove."] });
    expect(line(lines, "quickbooks").says).toMatch(/^Connected to .+ \(an Intuit sandbox, not the club's real books\)\.$/);
    expect(Date.parse(at(line(lines, "quickbooks"), "Last token refresh")!)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(at(line(lines, "quickbooks"), "Last roster read")!)).toBeGreaterThan(Date.now() - 60_000);
    expect(line(lines, "mail")).toMatchObject({ word: "Working", says: "Tested and working, sending through Microsoft 365.", times: [{ label: "Last sent", at: ago(60_000) }, { label: "Last failure", at: null }] });
    expect(line(lines, "parents")).toMatchObject({ word: "On" });
    expect(line(lines, "forms")).toMatchObject({ word: "Connected", says: "Connected to Documenso at https://sign.club.example." });
    expect(line(lines, "backup")).toMatchObject({ word: "Recent", notes: ["booster-rocket-20261115T030000Z.dump, 3.0 MB"], times: [{ label: "Last backup", at: ago(3_600_000) }] });

    const html = await renderPage(HealthPage);
    expect(html).toContain("Everything that is set up is working.");
    expect(html).toContain("Last failure: never");
    // Nothing of the connection but its name: no client id, no token, no company id.
    const [conn] = await db.select().from(qboConnection);
    for (const hidden of [conn!.clientId, conn!.realmId!, conn!.accessTokenCiphertext!, conn!.refreshTokenCiphertext!]) expect(html).not.toContain(hidden);
  });

  it("says, as needing attention, how many changes the portal keeps that QuickBooks didn't take (stage 3's slice 9e), pointing at Reconciliation", async () => {
    await admin();
    await seedConnected(stub);
    const refused = { realmId: "9130000000000001", state: "refused" as const, sent: false, lastCode: "fault_5010", nextTryAt: null, askedByLabel: "registrar@club.org" };
    await db.insert(writeQueue).values([
      { ...refused, request: { op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Household", was: "Rivera Family" }, targetQboId: "10" },
      { ...refused, request: { op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" }, targetQboId: "12" },
    ]);
    const quickbooks = line(await healthReport(NOW), "quickbooks");
    expect(quickbooks.state).toBe("attention");
    expect(quickbooks.notes).toContain("2 changes are kept in the portal that QuickBooks didn't take: the portal keeps its own value until someone sends it again or gives it up on the Reconciliation page.");
    // One reads as one, and the note on waiting and stuck changes isn't drawn for refused ones alone.
    await db.delete(writeQueue).where(eq(writeQueue.targetQboId, "12"));
    const one = line(await healthReport(NOW), "quickbooks");
    expect(one.notes).toContain("1 change is kept in the portal that QuickBooks didn't take: the portal keeps its own value until someone sends it again or gives it up on the Reconciliation page.");
    expect(one.notes.join(" ")).not.toContain("Changes waiting for QuickBooks");
  });

  it("says how the daily read of every family's invoices stands: never run, stopped part way, too old, working", async () => {
    await seedConnected(stub);
    const money = async () => line(await healthReport(NOW), "money");
    expect(await money()).toMatchObject({ state: "off", word: "Not yet run", fix: null });
    const finished = (ms: number, outcome: "ok" | "failed", detail: string | null = null) =>
      db.insert(jobRun).values({ job: MONEY_JOB, startedAt: new Date(Date.parse(ago(ms)) - 60_000), finishedAt: new Date(ago(ms)), outcome, detail, startedBy: "worker" });
    await finished(MONEY_OLD_MS - 1000, "ok");
    expect(await money()).toMatchObject({ state: "ok", word: "Working", times: [{ label: "Last finished", at: ago(MONEY_OLD_MS - 1000) }, { label: "Last stopped", at: null }] });
    await db.delete(jobRun).where(eq(jobRun.job, MONEY_JOB));
    await finished(MONEY_OLD_MS + 1000, "ok");
    expect(await money()).toMatchObject({ state: "attention", word: "Needs attention", fix: { href: "/staff/balances" } });
    await finished(60_000, "failed", "Read 3 families of 9, then stopped: QuickBooks didn't answer. The next run carries on from there.");
    const stopped = await money();
    expect(stopped).toMatchObject({ state: "attention", word: "Needs attention", notes: ["Read 3 families of 9, then stopped: QuickBooks didn't answer. The next run carries on from there."] });
    expect(stopped.says).toMatch(/stopped part way/);
  });

  it("warns when the worker has not woken for too long: a second inside the limit is fine, a second past it is not", async () => {
    await put(WAKE_KEY, { at: ago(WORKER_LATE_MS - 1000) });
    expect(line(await healthReport(NOW), "worker")).toMatchObject({ state: "ok", word: "Working" });
    await put(WAKE_KEY, { at: ago(WORKER_LATE_MS + 1000) });
    const late = line(await healthReport(NOW), "worker");
    expect(late).toMatchObject({ state: "attention", word: "Needs attention", times: [{ label: "Last woke", at: ago(WORKER_LATE_MS + 1000) }] });
    expect(late.says).toMatch(/has stopped checking in/);
  });

  it("warns when the last backup is more than two days old, and reads a value it can't trust as no backup", async () => {
    await put(BACKUP_KEY, { at: ago(BACKUP_OLD_MS - 1000), file: "booster-rocket-x.dump", bytes: 2048 });
    expect(line(await healthReport(NOW), "backup")).toMatchObject({ state: "ok", notes: ["booster-rocket-x.dump, 2 KB"] });
    await put(BACKUP_KEY, { at: ago(BACKUP_OLD_MS + 1000), file: "booster-rocket-x.dump", bytes: 2048 });
    expect(line(await healthReport(NOW), "backup")).toMatchObject({ state: "attention", word: "Needs attention" });
    for (const bad of [{ at: "not a time" }, { file: "x" }, "yesterday", 5, { at: 12345 }]) {
      await put(BACKUP_KEY, bad);
      expect(line(await healthReport(NOW), "backup"), JSON.stringify(bad)).toMatchObject({ state: "attention", word: "None recorded", times: [{ label: "Last backup", at: null }] });
    }
  });

  it("says whether Documenso's database was part of the last backup, as backup.sh recorded it", async () => {
    const at1 = ago(3_600_000);
    await put(BACKUP_KEY, { at: at1, file: "booster-rocket-x.dump", bytes: 2048, documenso: { file: "documenso-x.dump", bytes: 3 * 1024 * 1024 } });
    expect(line(await healthReport(NOW), "backup")).toMatchObject({ state: "ok", notes: ["booster-rocket-x.dump, 2 KB", "Documenso's database too: documenso-x.dump, 3.0 MB"] });
    await put(BACKUP_KEY, { at: at1, file: "booster-rocket-x.dump", bytes: 2048, documenso: null });
    expect(line(await healthReport(NOW), "backup").notes).toEqual(["booster-rocket-x.dump, 2 KB", "Documenso's database wasn't part of this backup."]);
    // With forms signed in Documenso, a backup without its database is said plainly; the state is still the backup's age.
    await connectForms({ origin: "https://sign.club.example", token: "api_made_up_for_the_health_page" });
    const withForms = line(await healthReport(NOW), "backup");
    expect(withForms.state).toBe("ok");
    expect(withForms.notes[1]).toMatch(/^Documenso's database wasn't part of this backup, though forms are signed in Documenso\./);
    // A record from before backup.sh knew of Documenso says nothing about it, and one it can't read is the same.
    for (const documenso of [undefined, "yes", { bytes: 5 }]) {
      await put(BACKUP_KEY, { at: at1, file: "booster-rocket-x.dump", bytes: 2048, ...(documenso === undefined ? {} : { documenso }) });
      expect(line(await healthReport(NOW), "backup").notes, JSON.stringify(documenso)).toEqual(["booster-rocket-x.dump, 2 KB"]);
    }
  });

  it("says when mail is untested, and when the last send failed", async () => {
    await put("mail", { method: "graph", mailbox: "webmaster@example.org" });
    expect(line(await healthReport(NOW), "mail")).toMatchObject({ state: "attention", word: "Not tested" });
    await db.delete(setting).where(eq(setting.key, "mail"));
    await seedWorkingMail();
    await patchMailStatus({ lastSuccessAt: ago(120_000), lastFailureAt: ago(60_000), lastError: "The mail server refused the sign-in. (auth)" });
    expect(line(await healthReport(NOW), "mail")).toMatchObject({ state: "attention", word: "Needs attention", notes: ["The mail server refused the sign-in. (auth)"],
      times: [{ label: "Last sent", at: ago(120_000) }, { label: "Last failure", at: ago(60_000) }] });
    await patchMailStatus({ lastSuccessAt: ago(30_000) });
    expect(line(await healthReport(NOW), "mail")).toMatchObject({ state: "ok" });
  });

  it("says when QuickBooks is set up but not connected, and passes on what needs attention when it is", async () => {
    await seedConnected(stub);
    await db.update(qboConnection).set({ lastError: "Intuit refused the refresh. (invalid_grant)", lastErrorAt: new Date() });
    const broken = line(await healthReport(), "quickbooks");
    expect(broken).toMatchObject({ state: "attention", word: "Needs attention", fix: { href: "/staff/settings/quickbooks" } });
    expect(broken.notes.join(" ")).toContain("Intuit refused the refresh. (invalid_grant)");
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, accessTokenCiphertext: null, lastError: null });
    expect(line(await healthReport(), "quickbooks")).toMatchObject({ state: "attention", word: "Not connected" });
  });

  it("says what the portal reads and what it changes in QuickBooks, in the words the QuickBooks settings pages use", async () => {
    await admin();
    await seedConnected(stub);
    const connected = line(await healthReport(), "quickbooks");
    expect(connected.notes).toContain(`${QUICKBOOKS_USE.reads} ${QUICKBOOKS_USE.writes}`);
    // No change has been made in QuickBooks here.
    expect(connected.times).toContainEqual({ label: "Last change made in QuickBooks", at: null });
    const health = await renderPage(HealthPage);
    const settings = await renderPage(QuickBooksSettingsPage);
    const setup = await renderPage(QuickBooksSetupPage, { searchParams: { step: "connect" } });
    const said = (words: string) => words.replaceAll("'", "&#x27;");
    for (const html of [health, settings, setup]) {
      expect(html).toContain(said(QUICKBOOKS_USE.reads));
      expect(html).toContain(said(QUICKBOOKS_USE.writes));
      expect(html).not.toMatch(/changes nothing (there|in QuickBooks)|only reads/);
    }
    expect(QUICKBOOKS_USE.reads).toMatch(/families and members.*what each family owes/);
    expect(QUICKBOOKS_USE.writes).toMatch(/email address a parent signs in with.*new families, students, parents and members.*inactive.*never deletes/);
    // A guardian's phone and mailing address are the portal's own (stage 3's slice 11a), and sent on after the portal
    // saves a parent's change (slice 11b), never over details the portal didn't know of.
    expect(QUICKBOOKS_USE.writes).toMatch(/phone and mailing address, on their own record.*after the portal saves a change a parent or staff make to them, and never over details QuickBooks holds that the portal didn't know of/);
    expect(QUICKBOOKS_USE.reads).toMatch(/phone and mailing address are the portal's own: it takes them in once/);
    // A buy-out invoice carries the chooser's sign-in address so it can be paid online, and nothing is emailed (2026-11-17).
    expect(QUICKBOOKS_USE.writes).toMatch(/pay instead of volunteering.*sign-in email address as its bill-to address, so it can be paid online; nothing is emailed/);
    expect(health).toContain("Last change made in QuickBooks: never");

    // A parent's save, and a staff change to the roster, are audited under these actions (tests/integration/contact-edits.test.ts,
    // roster-writes.test.ts): the newest one is the time shown, and a refusal is not one.
    const actor = { door: "parent" as const, id: "p-1", label: "ana@example.com" };
    await writeAudit({ actor, action: "parent.contact.save", targetType: "qbo_customer", targetId: "11" });
    await writeAudit({ actor, action: "parent.contact.save.failed", targetType: "qbo_customer", targetId: "11", after: { code: "timeout" } });
    const [saved] = (await db.select().from(auditLog)).filter((a) => a.action === "parent.contact.save");
    expect(at(line(await healthReport(), "quickbooks"), "Last change made in QuickBooks")).toBe(saved!.at.toISOString());
    const staff = { door: "staff" as const, id: null, label: "registrar@club.org" };
    await writeAudit({ actor: staff, action: "roster.customer.rename", targetType: "qbo_customer", targetId: "12" });
    await writeAudit({ actor: staff, action: "roster.write.refused", targetType: "qbo_customer", targetId: "12", after: { code: "fault_6240" } });
    const [renamed] = (await db.select().from(auditLog)).filter((a) => a.action === "roster.customer.rename");
    expect(QUICKBOOKS_WRITE_ACTION).toEqual(expect.arrayContaining(["parent.contact.save", "parent.email.save", "roster.customer.create", "roster.customer.rename", "roster.student.move", "roster.customer.deactivate"]));
    expect(at(line(await healthReport(), "quickbooks"), "Last change made in QuickBooks")).toBe(renamed!.at.toISOString());

    // Not connected: the page says what parents can't do meanwhile, too.
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, accessTokenCiphertext: null });
    const off = line(await healthReport(), "quickbooks");
    expect(off.says).toMatch(/can't read the roster or what families owe, and parents can't change the email they sign in with/);
    expect(off.notes).toEqual([`${QUICKBOOKS_USE.reads} ${QUICKBOOKS_USE.writes}`]);
  });

  it("says on the QuickBooks line, while the one-time copy of parents' phones and addresses hasn't run, what it waits for, and nothing once it has", async () => {
    const notes = async () => line(await healthReport(NOW), "quickbooks").notes.join(" ");
    const said = "Parents' phones and mailing addresses haven't been copied from QuickBooks into the portal yet.";
    const meanwhile = "Meanwhile a parent can type their own on their Family page, and the copy never replaces what a parent has typed.";
    // No setting (a database migration 0044 never wrote it into): nothing.
    expect(await notes()).not.toContain(said);
    await put("parents.contact_take_in", { after: ago(60_000) });
    // Not set up, then connected but with no shape, then with a shape and a read still to come.
    expect(await notes()).toContain(`${said} It copies them once an Admin connects QuickBooks and the roster has been read. ${meanwhile}`);
    await seedConnected(stub);
    expect(await notes()).toContain("It copies them once the membership shape names only customer types QuickBooks has, at the roster read after the shape is saved.");
    await put("membership.shape", { kind: "flat", memberTypeIds: ["1"] });
    await put("roster.source", { realmId: "9130000000000001" });
    await db.insert(qboCustomerType).values({ qboId: "1", name: "Family", active: true });
    expect(await notes()).toContain("It copies them after the worker's next successful read of the roster, which it tries at once and then once an hour until one works.");
    // The connection only an Admin can mend.
    await db.update(qboConnection).set({ lastError: "Intuit refused the refresh. (invalid_grant)", lastErrorAt: new Date() });
    expect(await notes()).toContain("It copies them once an Admin connects QuickBooks again");
    await db.update(qboConnection).set({ lastError: null, lastErrorAt: null });
    // A read that kept the addresses: only the next wake. The line's state is not changed by the note.
    await put("parents.contact_take_in", { after: ago(60_000), addressesReadAt: ago(30_000) });
    expect(await notes()).toContain("The roster has been read, so the worker copies them when it next wakes, within a minute.");
    // Done: nothing.
    await put("parents.contact_take_in", { after: ago(60_000), addressesReadAt: ago(30_000), doneAt: ago(10_000) });
    expect(await notes()).not.toContain(said);
  });

  it("says when the last clean-up failed", async () => {
    await db.insert(jobRun).values({ job: CLEANUP_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "failed", detail: "The clean-up couldn't finish. Nothing was removed. (unexpected)" });
    expect(line(await healthReport(), "cleanup")).toMatchObject({ state: "attention", times: [{ label: "Last tried" }] });
  });

  it("says on the clean-up line when the sweep of expired passkey challenges at every wake last failed, until one works (slice SI-7a)", async () => {
    await markJob(CHALLENGE_SWEEP_MARK, "threw");
    const failedAt = (await readMark(CHALLENGE_SWEEP_MARK))!.failedAt;
    expect(line(await healthReport(), "cleanup")).toMatchObject({ state: "attention", word: "Needs attention", says: SWEEP_FAILED,
      times: [{ label: "Last ran", at: null }, { label: "Challenge sweep last failed", at: failedAt }] });
    // The daily clean-up failing too: its own words, and the sweep's beside them.
    await db.insert(jobRun).values({ job: CLEANUP_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "failed", detail: "The clean-up couldn't finish. Nothing was removed. (unexpected)" });
    expect(line(await healthReport(), "cleanup")).toMatchObject({ state: "attention", says: "The last clean-up couldn't finish. The worker tries again in 15 minutes.",
      notes: ["The clean-up couldn't finish. Nothing was removed. (unexpected)", SWEEP_FAILED] });
    await db.delete(jobRun);
    // A sweep that works, even one that removed nothing, clears it.
    await markJob(CHALLENGE_SWEEP_MARK, { counts: { challenges: 0 }, failed: 0 });
    expect(line(await healthReport(), "cleanup")).toMatchObject({ state: "off", word: "Not yet run", notes: [], times: [{ label: "Last ran", at: null }] });
  });

  it("says when the reminders before a due date last looked, what they sent, and when the last one failed", async () => {
    const due = async () => line(await healthReport(NOW), "due_reminders");
    await seedParentSettings(SIGNINS_ON);
    expect(await due()).toMatchObject({ state: "off", word: "Off" });
    expect((await due()).says).toMatch(/only while parent sign-ins and welcome emails are both switched on/);
    await seedParentSettings({ welcome: true });
    // Switched on, but outgoing mail isn't set up and tested: the worker sends nothing, and the line says so.
    expect(await due()).toMatchObject({ state: "off", word: "Waiting for mail", fix: { href: "/staff/settings/mail" } });
    await seedWorkingMail();
    expect(await due()).toMatchObject({ state: "ok", word: "On", notes: ["It hasn't looked yet. It looks each day from 9:00 club time."],
      times: [{ label: "Last looked", at: null }, { label: "Last sent", at: null }, { label: "Last failure", at: null }] });
    await put(DUE_REMINDERS_KEY, { day: "2027-03-10", at: ago(3_600_000), sent: 0, failed: 0, lastSentAt: null, lastFailedAt: null });
    expect((await due()).notes).toEqual(["On Wednesday, March 10, 2027, the last day it looked, no family was owed a reminder."]);
    await put(DUE_REMINDERS_KEY, { day: "2027-03-10", at: ago(60_000), sent: 3, failed: 0, lastSentAt: ago(60_000), lastFailedAt: ago(86_400_000) });
    expect(await due()).toMatchObject({ state: "ok", notes: ["On Wednesday, March 10, 2027, the last day it looked: 3 reminders sent."],
      times: [{ label: "Last looked", at: ago(60_000) }, { label: "Last sent", at: ago(60_000) }, { label: "Last failure", at: ago(86_400_000) }] });
    // The newest send failed: someone should look at mail.
    await put(DUE_REMINDERS_KEY, { day: "2027-03-10", at: ago(30_000), sent: 3, failed: 1, lastSentAt: ago(60_000), lastFailedAt: ago(30_000) });
    const failing = await due();
    expect(failing).toMatchObject({ state: "attention", word: "Needs attention", fix: { href: "/staff/settings/mail" },
      notes: ["On Wednesday, March 10, 2027, the last day it looked: 3 reminders sent, and 1 email couldn't be sent."] });
    expect(failing.says).toMatch(/couldn't be sent/);
    // A value it can't read is no record at all.
    await put(DUE_REMINDERS_KEY, { day: 5, at: "not a time" });
    expect(await due()).toMatchObject({ state: "ok", times: [{ label: "Last looked", at: null }, { label: "Last sent", at: null }, { label: "Last failure", at: null }] });
  });

  it("says when the latest sign-ins came with no address, and that it is the header when one is named", async () => {
    const setting = env.CLIENT_IP_HEADER;
    try {
      await seedParentSettings(SIGNINS_ON);
      const signin = (ip: string | null, atMs: number) => db.insert(auditLog).values({ at: new Date(NOW.getTime() - atMs), door: "parent", actorLabel: "ana@example.com", action: "signin.code_sent", ip });
      // No sign-ins yet: nothing to go on.
      expect(line(await healthReport(NOW), "parents")).toMatchObject({ state: "ok", notes: [] });
      // An address, then none since: not yet a sign that the header is missing.
      await signin("203.0.113.7", 3_600_000); await signin(null, 60_000);
      expect(line(await healthReport(NOW), "parents")).toMatchObject({ state: "ok", notes: [] });
      // Only sign-ins with no address in the last two weeks: the proxy doesn't send the header the portal reads.
      await db.delete(auditLog); await signin("203.0.113.7", SIGNIN_ADDRESS_LOOKBACK_MS + 60_000); await signin(null, 60_000);
      const missing = line(await healthReport(NOW), "parents");
      expect(missing).toMatchObject({ state: "attention", word: "Needs attention" });
      expect(missing.notes.join(" ")).toMatch(/doesn't send the header cf-connecting-ip\. Set CLIENT_IP_HEADER/);
      // Chosen: said, not a fault.
      env.CLIENT_IP_HEADER = "none";
      const chosen = line(await healthReport(NOW), "parents");
      expect(chosen).toMatchObject({ state: "ok", word: "On" });
      expect(chosen.notes.join(" ")).toMatch(/addresses aren't recorded, because CLIENT_IP_HEADER is none/);
    } finally { env.CLIENT_IP_HEADER = setting; }
  });

  it("says when welcome emails are waiting because mail is failing, and stops once a welcome goes", async () => {
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    await seedWorkingMail(); // tested: the worker would really try
    const owedOne = await seedParent({ name: "Owed One", welcomeOwed: true });
    const row = await seedGuardianInFamily({ parentId: owedOne.id, familyQboId: "10", status: "invited" });
    // Owed but with no guardian row, so no wake tries them: not counted.
    await seedParent({ name: "Owed No Row", welcomeOwed: true });
    const parents = async () => line(await healthReport(NOW), "parents");
    expect(await parents()).toMatchObject({ state: "ok", notes: [] });
    // The worker's last welcome failed: while it is so, it tries one person a wake (sendOwedWelcomes()).
    await markJob(WELCOME_MARK, { counts: { sent: 0, recipientRefused: 0, linkNotInPlace: 0 }, failed: 1 });
    const waiting = await parents();
    expect(waiting).toMatchObject({ state: "attention", word: "Needs attention", fix: { href: "/staff/settings/mail" } });
    expect(waiting.notes).toEqual(["Welcome emails are waiting because mail is failing: 1 person is owed a welcome or a link to choose a password, and the last one the worker tried to send failed. Until a send works, it tries one person a minute instead of five."]);
    // Mail settings saved but not tested: the worker tries nobody, so the note says nothing (the mail line says why).
    const tested = (await getMailStatus()).verifiedHash;
    await patchMailStatus({ verifiedHash: "saved-since-and-not-tested" });
    expect(await parents()).toMatchObject({ state: "ok", notes: [], fix: null });
    expect(line(await healthReport(NOW), "mail")).toMatchObject({ word: "Not tested" });
    await patchMailStatus({ verifiedHash: tested });
    expect((await parents()).notes).toHaveLength(1);
    // Their family made inactive: they stay owed but can't sign in, so no wake tries anyone and the mark stays failed,
    // yet nobody is waiting to be sent to, and the note goes.
    await db.update(family).set({ active: false }).where(eq(family.id, row.familyId!));
    expect(await parents()).toMatchObject({ state: "ok", notes: [], fix: null });
    await db.update(family).set({ active: true }).where(eq(family.id, row.familyId!));
    expect((await parents()).notes).toHaveLength(1);
    // Nobody owed, or welcome emails off: nothing is waiting.
    await seedParentSettings({ ...SIGNINS_ON, welcome: false });
    expect(await parents()).toMatchObject({ state: "ok", notes: [] });
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    await markJob(WELCOME_MARK, { counts: { sent: 1, recipientRefused: 0, linkNotInPlace: 0 }, failed: 0 });
    expect(await parents()).toMatchObject({ state: "ok", notes: [], fix: null });
  });

  it("says how the password breach check stands: not used yet, working, and a failure the latest word, with why", async () => {
    const breach = async () => line(await healthReport(NOW), "breach_check");
    expect(await breach()).toMatchObject({ state: "off", word: "Not used yet", fix: null });
    expect((await breach()).says).toMatch(/^Not used yet./);
    const t1 = new Date(NOW.getTime() - 3_600_000), t2 = new Date(NOW.getTime() - 60_000), t3 = new Date(NOW.getTime() - 1000);
    await markBreachCheck({ outcome: "found" }, t1);
    expect(await breach()).toMatchObject({ state: "ok", word: "Working", notes: [], times: [{ label: "Last answered", at: t1.toISOString() }, { label: "Last failed", at: null }] });
    await markBreachCheck({ outcome: "not_checked", why: "timeout" }, t2);
    const failed = await breach();
    expect(failed).toMatchObject({ state: "attention", word: "Needs attention", notes: ["The last time it didn't answer within 3 seconds."],
      times: [{ label: "Last answered", at: t1.toISOString() }, { label: "Last failed", at: t2.toISOString() }] });
    expect(failed.says).toMatch(/passwords chosen since then were accepted without the check/);
    expect(failed.says).toMatch(/server must be able to reach the service/);
    for (const why of ["unreachable", "bad_answer"] as const) {
      await markBreachCheck({ outcome: "not_checked", why }, t2);
      expect((await breach()).notes).toEqual([why === "unreachable" ? "The last time it couldn't be reached." : "The last time its answer couldn't be read."]);
    }
    // An answer after the failure is the latest word again, even at the same instant.
    await markBreachCheck({ outcome: "not_found" }, t2);
    expect(await breach()).toMatchObject({ state: "ok", times: [{ label: "Last answered", at: t2.toISOString() }, { label: "Last failed", at: t2.toISOString() }] });
    await markBreachCheck({ outcome: "not_found" }, t3);
    expect((await readBreachMark())).toEqual({ answeredAt: t3.toISOString(), failedAt: t2.toISOString(), failure: "bad_answer", failedLast: false });
    // The mark is counts and times only.
    const [row] = await db.select().from(setting).where(eq(setting.key, BREACH_MARK));
    expect(Object.keys(row!.value as object).sort()).toEqual(["answeredAt", "failedAt", "failedLast", "failure"]);
  });

  it("leaves /api/health a bare liveness check that says nothing else", async () => {
    await admin();
    const res = await liveness();
    expect(await res.text()).toBe('{"ok":true}');
    expect([...res.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
  });
});

describe("the lines for the worker's jobs with no run history of their own", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("says how the volunteer reminders stand: off with sign-ins, waiting for mail, never run, working, and what failed", async () => {
    const reminders = async () => line(await healthReport(NOW), "volunteer_reminders");
    expect(await reminders()).toMatchObject({ state: "off", word: "Off", fix: { href: "/staff/settings/parents" } });
    await seedParentSettings(SIGNINS_ON);
    expect(await reminders()).toMatchObject({ state: "off", word: "Waiting for mail", fix: { href: "/staff/settings/mail" } });
    await seedWorkingMail();
    expect(await reminders()).toMatchObject({ state: "off", word: "Not yet run", times: [{ label: "Last looked", at: null }, { label: "Last sent", at: null }, { label: "Last failure", at: null }] });
    await runDueJobs(); // a wake looks, and has nothing to send
    const looked = await reminders();
    expect(looked).toMatchObject({ state: "ok", word: "Working", times: [{ label: "Last looked", at: expect.any(String) }, { label: "Last sent", at: null }, { label: "Last failure", at: null }] });
    expect(looked.notes).toEqual(["The nudges before a volunteer due date wait until welcome emails are switched on; the reminders the day before a shift go."]);

    // Later wakes, each a second after the one before.
    const start = Date.now(), wake = (n: number) => new Date(start + n * 1000);
    await markJob(REMINDERS_MARK, { counts: { sent: 3 }, failed: 2 }, wake(1));
    const failing = await reminders();
    expect(failing).toMatchObject({ state: "attention", word: "Needs attention", fix: { href: "/staff/settings/mail" }, notes: expect.arrayContaining(["The last ones that went: 3 reminders."]) });
    expect(failing.says).toMatch(/^2 volunteer reminders couldn't be sent at the last try\./);
    expect(at(failing, "Last sent")).toBe(wake(1).toISOString());
    // The wakes after a failed send send nothing (a failed reminder waits 15 minutes): they say nothing about mail, so
    // the failure stands until a send goes through.
    await markJob(REMINDERS_MARK, { counts: { sent: 0 }, failed: 0 }, wake(1.5));
    expect(await reminders()).toMatchObject({ state: "attention", word: "Needs attention" });
    await markJob(REMINDERS_MARK, "threw", wake(2));
    expect((await reminders()).says).toBe("The last try to send volunteer reminders stopped with an error. The worker tries again at its next wake, a minute later.");
    // A later look with nothing failing is working again; the failure keeps its time.
    await markJob(REMINDERS_MARK, { counts: { sent: 0 }, failed: 0 }, wake(3));
    expect(await reminders()).toMatchObject({ state: "ok", times: [{ label: "Last looked", at: wake(3).toISOString() }, { label: "Last sent", at: wake(1).toISOString() }, { label: "Last failure", at: wake(2).toISOString() }] });
    // Some failed again; an idle wake leaves it failing, and a wake that sends with nothing failing is working again.
    await markJob(REMINDERS_MARK, { counts: { sent: 0 }, failed: 1 }, wake(4));
    await markJob(REMINDERS_MARK, { counts: { sent: 0 }, failed: 0 }, wake(5));
    expect((await reminders()).says).toMatch(/^1 volunteer reminder couldn't be sent at the last try\./);
    await markJob(REMINDERS_MARK, { counts: { sent: 1 }, failed: 0 }, wake(6));
    expect(await reminders()).toMatchObject({ state: "ok", word: "Working" });
  });

  it("takes the latest word from the mark itself: two wakes in one millisecond, and two marking at once", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedWorkingMail();
    const reminders = async () => line(await healthReport(NOW), "volunteer_reminders");
    // One millisecond, in either order: equal times can't say which came last, the mark does.
    const t = new Date();
    await markJob(REMINDERS_MARK, { counts: { sent: 1 }, failed: 0 }, t);
    await markJob(REMINDERS_MARK, { counts: { sent: 0 }, failed: 1 }, t);
    expect(await reminders()).toMatchObject({ state: "attention", word: "Needs attention" });
    await markJob(REMINDERS_MARK, { counts: { sent: 1 }, failed: 0 }, t);
    expect(await reminders()).toMatchObject({ state: "ok", word: "Working" });

    // Two wakes at once, with the mark's row held so both are at it before either writes: neither's mark is lost.
    let release!: () => void, holding!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holds = new Promise<void>((resolve) => { holding = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(setting).where(eq(setting.key, REMINDERS_MARK)).for("update");
      holding();
      await held;
    });
    await holds;
    const later = (s: number) => new Date(t.getTime() + s * 1000);
    const sending = markJob(REMINDERS_MARK, { counts: { sent: 2 }, failed: 0 }, later(1));
    const throwing = markJob(REMINDERS_MARK, "threw", later(2));
    await untilALockIsAwaited(15_000, 2);
    release();
    await Promise.all([holder, sending, throwing]);
    expect(await readMark(REMINDERS_MARK)).toMatchObject({ didAt: later(1).toISOString(), did: { sent: 2 }, failedAt: later(2).toISOString(), failure: { kind: "threw" } });
  });

  it("says how the daily check of the buy-out invoices stands: not running, never run, behind a read, working, and what it found", async () => {
    const check = async () => line(await healthReport(NOW), "buyout_check");
    expect(await check()).toMatchObject({ state: "off", word: "Not running" });
    await seedConnected(stub);
    expect(await check()).toMatchObject({ state: "off", word: "Not yet run", times: [{ label: "Last checked", at: null }, { label: "Last failure", at: null }] });
    // A read of every family finished a while ago, and the check hasn't followed it.
    await db.insert(jobRun).values({ job: MONEY_JOB, startedAt: new Date(NOW.getTime() - BUYOUT_CHECK_LATE_MS - 120_000), finishedAt: new Date(NOW.getTime() - BUYOUT_CHECK_LATE_MS - 1000), outcome: "ok", startedBy: "worker" });
    const behind = await check();
    expect(behind).toMatchObject({ state: "attention", word: "Needs attention" });
    expect(behind.says).toMatch(/haven't been checked against it/);
    await runDueJobs(); // the wake's check follows that read
    const working = await check();
    expect(working).toMatchObject({ state: "ok", word: "Working", notes: ["It has found nothing to change so far."] });
    expect(Date.parse(at(working, "Last checked")!)).toBeGreaterThan(Date.now() - 60_000);

    // What it did last, in words, and a flag of its own waiting for the treasurer.
    await markJob(BUYOUT_CHECK_MARK, { counts: { paid: 2, flagged: 1, voided: 0, voiding: 0, unflagged: 0 }, failed: 0 }, new Date(Date.now() + 1000));
    const requirementId = await seedBuyoutRequirement();
    await seedBuyout({ requirementId, familyQboId: "10", chosenBy: randomUUID(), flag: "missing" });
    // And one whose student the check found no longer under the family, with no void tried; one a void was tried for is the treasurer's, not counted.
    await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Gate shifts" }), familyQboId: "10", chosenBy: randomUUID(), flag: "student_moved" });
    const voidTried = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Clean-up shifts" }), familyQboId: "10", chosenBy: randomUUID(), flag: "student_moved" });
    await db.update(buyout).set({ lastCode: "paid" }).where(eq(buyout.id, voidTried.id));
    const flagged = await check();
    expect(flagged).toMatchObject({ state: "attention", fix: { href: "/staff/reconciliation" } });
    expect(flagged.notes).toEqual([
      "2 buy-out invoices are flagged and waiting for the club: QuickBooks no longer shows them, shows them on another customer, or no longer holds the student billed under the family. The Reconciliation page lists them.",
      "The last time it changed something: 2 marked paid, 1 flagged for the club.",
    ]);
    await markJob(BUYOUT_CHECK_MARK, "threw", new Date(Date.now() + 2000));
    expect((await check()).says).toBe("The last check of the buy-out invoices stopped with an error. The worker tries again at its next wake, a minute later.");
  });
});
