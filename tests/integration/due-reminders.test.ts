import { describe, it, expect, beforeEach, vi } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], failFor: new Set<string>() }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => {
  if (mail.failFor.has(m.to)) throw new Error("refused");
  mail.outbox.push(m);
} }));

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, familyMoney, guardian, parent, qboConnection, requirement, requirementProgress, requirementReminder, setting, student } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { formatMoney } from "@/lib/money/cents";
import { getParentSettings, putParentSettings } from "@/lib/parents/settings";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { DUE_REMINDERS_JOB, DUE_REMINDERS_KEY, lastDueReminders, noteLook, sendDueReminders } from "@/lib/seasons/due-reminders";
import { FIGURES_TELL_MS } from "@/lib/seasons/due-reminder-rules";
import { resetDb, seedWorkingMail, untilALockIsAwaited } from "../helpers/db";
import { ageMoney } from "../helpers/money";
import { FAMILY_A, FAMILY_B, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { TRIP_DEPOSIT_ITEM } from "../helpers/season";
import { P_SHAPE } from "../helpers/roster-cache";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { recordOfCustomer, subjectColumns } from "../helpers/app-records";

/**
 * The reminders before a required payment's or checklist item's due date (src/lib/seasons/due-reminders.ts): 14 and 3
 * days before, from 9:00 on the club's clock, one email per guardian of each family that still has one to do, covering
 * every such requirement of theirs due that day. Only while parent sign-ins and welcome emails are both on; each
 * claimed before it is sent, so it goes once; a payment's amount only from fresh figures, and nothing when the figures
 * can't tell whether it was paid. No email names another family or shows a staff note.
 */
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const setZone = (timeZone: string) => db.insert(setting).values({ key: "club", value: { timeZone } }).onConflictDoUpdate({ target: setting.key, set: { value: { timeZone } } });
const switches = async (o: { signin?: boolean; welcome?: boolean; requireActiveStudents?: boolean }) => {
  const s = await getParentSettings();
  await db.transaction((tx) => putParentSettings(tx, { ...s, ...o }));
};
const to = (who: SeededParent) => mail.outbox.filter((m) => m.to === who.spec.parent.email);
const [AURELIO, AZALEA] = FAMILY_A.students, [BARNABY, BEATRIX] = FAMILY_B.students;
const at = (iso: string) => new Date(iso);
/** March 10, 2027 at 9:30 in UTC, the club's zone until one is set: 14 days before March 24, 3 before March 13. */
const WAKE = "2027-03-10T09:30:00Z";
const FEE = "Band fee QR21", MEDICAL = "Medical form handed in QR22", LOCKER = "Locker returned QR23", WAIVER_REASON = "Graduated early QR24";
const B_FEE_LEFT = formatMoney(FAMILY_B.invoices!.find((i) => i.items?.includes(TRIP_DEPOSIT_ITEM))!.cents);

vi.setConfig({ testTimeout: 30_000 });
beforeEach(async () => { await resetDb(); mail.outbox.length = 0; mail.failFor.clear(); });

/**
 * In the season seedTwoFamilies() makes current, with the fresh figures it stores for both families:
 * - a required per-family payment due March 24 carrying the trip deposit's item: A has paid it, B has not;
 * - a required per-family checklist item due March 13, ticked off for A;
 * - a required per-student checklist item due March 13, ticked for Azalea and waived for Barnaby (with a reason);
 * - an optional checklist item and a payment nobody has an invoice for yet, both due, which send nothing;
 * - a checklist item due a day that is neither 14 nor 3 days away.
 */
async function season() {
  const { a, b } = await seedTwoFamilies();
  await seedWorkingMail();
  const [handbook] = await db.select().from(requirement).where(eq(requirement.title, "Handbook read"));
  const values = { stepId: handbook!.stepId, required: true, covers: "everyone" as const, appliesTo: "family" as const };
  const ids: Record<string, string> = {};
  for (const [position, r] of ([
    { title: FEE, kind: "payment", itemQboId: TRIP_DEPOSIT_ITEM, dueOn: "2027-03-24" },
    { title: MEDICAL, kind: "checklist", dueOn: "2027-03-13" },
    { title: LOCKER, kind: "checklist", appliesTo: "student", dueOn: "2027-03-13" },
    { title: "Raffle tickets QR25", kind: "checklist", required: false, dueOn: "2027-03-13" },
    { title: "Spirit wear QR26", kind: "payment", itemQboId: "5151", dueOn: "2027-03-24" },
    { title: "Program ad QR27", kind: "checklist", dueOn: "2027-03-20" },
  ] as const).entries()) {
    const [row] = await db.insert(requirement).values({ ...values, ...r, position: 60 + position }).returning();
    ids[r.title] = row!.id;
  }
  // Ticks and waivers name the app's own records (stage 2 of the app-owned families spec).
  await db.insert(requirementProgress).values([
    { requirementId: ids[MEDICAL]!, ...(await subjectColumns(FAMILY_A.family.qboId, "family")), metAt: new Date() },
    { requirementId: ids[LOCKER]!, ...(await subjectColumns(AZALEA!.qboId, "student")), metAt: new Date() },
    { requirementId: ids[LOCKER]!, ...(await subjectColumns(BARNABY!.qboId, "student")), waivedAt: new Date(), waivedReason: WAIVER_REASON },
  ]);
  await switches({ welcome: true });
  return { a, b, ids };
}

describe("the reminders before a due date", () => {
  it("emails each family that still has one to do, once per due date, with only its own requirements and where each stands", async () => {
    const { a, b } = await season();
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 3, failed: 0 });
    expect(mail.outbox.map((m) => [m.to, m.subject]).sort()).toEqual([
      [FAMILY_A.parent.email, `Due Saturday, March 13, 2027: ${LOCKER}`],
      [FAMILY_B.parent.email, "Due Saturday, March 13, 2027: 2 things for the club"],
      [FAMILY_B.parent.email, `Due Wednesday, March 24, 2027: ${FEE}`],
    ].sort());
    const [forA] = to(a);
    expect(forA!.text).toContain("something the club asks of your family is due Saturday, March 13, 2027, 3 days from now.");
    expect(forA!.text).toContain(`${LOCKER} for ${AURELIO!.name}: Not done yet.`);
    expect(forA!.text).toContain("Everything the club asks this season is here: http://localhost:3000/season");
    expect(forA!.text).not.toContain("/payments");
    // A has paid the fee, ticked the medical form and Azalea's locker: none of them is mentioned.
    for (const done of [FEE, MEDICAL, AZALEA!.name]) expect(forA!.text).not.toContain(done);
    const fee = to(b).find((m) => m.subject.includes("March 24"))!.text;
    expect(fee).toContain("14 days from now");
    // The figures are fresh: the amount still to pay, as the Payments page says it.
    expect(fee).toContain(`${FEE}: Not paid yet (${B_FEE_LEFT} left to pay).`);
    expect(fee).toContain("You can see what's owed and pay on the Payments page: http://localhost:3000/payments");
    const three = to(b).find((m) => m.subject.includes("March 13"))!.text;
    expect(three).toContain(`${MEDICAL}: Not done yet.`);
    expect(three).toContain(`${LOCKER} for ${BEATRIX!.name}: Not done yet.`);
    expect(three).not.toContain(BARNABY!.name); // waived
    // Never an optional item, a payment with no invoice yet, or one due another day.
    const all = mail.outbox.map((m) => m.text + m.html).join(" ");
    for (const never of ["Raffle tickets QR25", "Spirit wear QR26", "Program ad QR27"]) expect(all).not.toContain(never);
    // Nothing of the other family, and no reason or note staff wrote.
    for (const secret of [WAIVER_REASON, ...a.season!.staffOnly, ...b.season!.staffOnly]) expect(all).not.toContain(secret);
    for (const m of to(a)) for (const marker of b.markers) expect(m.text + m.html + m.subject).not.toContain(marker);
    for (const m of to(b)) for (const marker of a.markers) expect(m.text + m.html + m.subject).not.toContain(marker);
    // Once: a later wake the same day sends nothing more.
    expect(await sendDueReminders(at("2027-03-10T15:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(mail.outbox).toHaveLength(3);
    expect((await db.select().from(requirementReminder)).map((r) => r.outcome)).toEqual(["sent", "sent", "sent"]);
    // Audited with the counts, never an address.
    const rows = await audits("season.due_reminders.sent");
    expect(rows).toMatchObject([{ door: "system", after: { clubDate: "2027-03-10", sent: 3, failed: 0 } }]);
    for (const email of [FAMILY_A.parent.email, FAMILY_B.parent.email]) expect(JSON.stringify(rows)).not.toContain(email);
  });

  it("says a payment's amount only from figures within freshSeconds, and points to Payments instead", async () => {
    const { b } = await season();
    await ageMoney(FAMILY_B.family.qboId, 10 * 60_000);
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 3, failed: 0 });
    const fee = to(b).find((m) => m.subject.includes("March 24"))!;
    expect(fee.text).toContain(`${FEE}: Not paid yet.`);
    expect(fee.text + fee.html).not.toContain(B_FEE_LEFT);
    expect(fee.text).toContain("http://localhost:3000/payments");
  });

  it("sends nothing while QuickBooks is connected to another company than the roster's, as before stage 3, and all again once disconnected", async () => {
    await season();
    // A connection to another company stored without a connect's refusal (from before it, or by hand); no request is made.
    await db.insert(qboConnection).values({ environment: "sandbox", clientId: "test-client-id", clientSecretCiphertext: "unused", clientSecretKeyId: "unused", realmId: "9130000000000002" });
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 0, failed: 0 });
    expect(mail.outbox).toEqual([]);
    expect(await db.select().from(requirementReminder)).toEqual([]);
    await db.update(qboConnection).set({ realmId: null });
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 3, failed: 0 });
  });

  it("sends nothing about a payment the figures can't tell about, and nothing about a paid one however old its figures", async () => {
    const { a, b } = await season();
    // B's figures are older than the worker's daily read would leave them, A's a month old: neither may be trusted to say B owes, and A's still say paid.
    await ageMoney(FAMILY_B.family.qboId, FIGURES_TELL_MS + 60_000);
    await ageMoney(FAMILY_A.family.qboId, 30 * 86_400_000);
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 2, failed: 0 });
    expect(mail.outbox.map((m) => m.subject).some((s) => s.includes("March 24"))).toBe(false);
    // No figures at all for B: the same.
    await db.delete(familyMoney).where(eq(familyMoney.familyId, await recordOfCustomer(FAMILY_B.family.qboId, "family")));
    await db.delete(requirementReminder);
    mail.outbox.length = 0;
    expect(await sendDueReminders(at("2027-03-10T10:00:00Z"))).toEqual({ sent: 2, failed: 0 });
    expect(to(b).map((m) => m.subject)).toEqual(["Due Saturday, March 13, 2027: 2 things for the club"]);
    expect(to(a).map((m) => m.subject)).toEqual([`Due Saturday, March 13, 2027: ${LOCKER}`]);
  });

  it("goes only while parent sign-ins and welcome emails are both on and mail works, from 9:00, on the two days only", async () => {
    await season();
    await switches({ welcome: false });
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 0, failed: 0 });
    await switches({ welcome: true, signin: false });
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 0, failed: 0 });
    await switches({ signin: true });
    expect(await sendDueReminders(at("2027-03-10T08:59:59Z"))).toEqual({ sent: 0, failed: 0 });
    // Not on the days in between, nor on the due date itself.
    for (const day of ["2027-03-09", "2027-03-11", "2027-03-13", "2027-03-24"]) expect(await sendDueReminders(at(`${day}T10:00:00Z`)), day).toEqual({ sent: 0, failed: 0 });
    await db.delete(setting).where(eq(setting.key, "mail.status"));
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 0, failed: 0 });
    expect(mail.outbox).toEqual([]);
    expect(await db.select().from(requirementReminder)).toEqual([]);
    await db.delete(setting).where(eq(setting.key, "mail"));
    await seedWorkingMail();
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 3, failed: 0 });
  });

  it("reads 9:00 and the day in the club's zone, never the server's", async () => {
    await season();
    // 20:00 UTC on March 9 is 10:00 on March 10 in Kiritimati, and 9:00 on March 9 in Pago Pago.
    await setZone("Pacific/Pago_Pago");
    expect(await sendDueReminders(at("2027-03-09T20:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    await setZone("Pacific/Kiritimati");
    expect(await sendDueReminders(at("2027-03-09T19:59:00Z"))).toEqual({ sent: 3, failed: 0 });
    // 8:59 in Kiritimati on March 10 is too early there.
    await db.delete(requirementReminder);
    expect(await sendDueReminders(at("2027-03-09T18:59:00Z"))).toEqual({ sent: 0, failed: 0 });
  });

  it("goes to the family's guardians whose row counts at the gate and who aren't blocked", async () => {
    const { a, b } = await season();
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.identity.parentId));
    await db.update(guardian).set({ status: "disabled" }).where(eq(guardian.id, b.identity.guardianId));
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 0, failed: 0 });
    expect(mail.outbox).toEqual([]);
  });

  // A reminder asks them to sign in: it goes only to guardians the gate would let in (guardianRowCounts()), so none to
  // a family with no active student while the club asks for one, though nothing closed its rows.
  it("goes to no guardian of a family with no active student while the club asks for one", async () => {
    await season();
    await db.update(student).set({ active: false }).where(eq(student.familyId, await recordOfCustomer(FAMILY_B.family.qboId, "family")));
    // Off: B is reminded of its own family's two, as before.
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 3, failed: 0 });
    await db.delete(requirementReminder); mail.outbox.length = 0;
    await switches({ requireActiveStudents: true });
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 1, failed: 0 });
    expect(mail.outbox.map((m) => m.to)).toEqual([FAMILY_A.parent.email]);
    expect((await db.select({ status: guardian.status }).from(guardian)).every((g) => g.status !== "disabled")).toBe(true);
    // Whatever the shape names (stage 5's slice P2: students are always the portal's own), it stays in force: B is not
    // reminded. The shape is stored alone, bringing nothing into step.
    for (const stale of [{ kind: "flat", memberTypeIds: ["F"] }, { ...P_SHAPE, studentTypeId: null }]) {
      await db.delete(requirementReminder); mail.outbox.length = 0;
      await db.update(setting).set({ value: stale }).where(eq(setting.key, SHAPE_KEY));
      await sendDueReminders(at(WAKE));
      expect(mail.outbox.map((m) => m.to)).not.toContain(FAMILY_B.parent.email);
    }
  });

  it("claims each email before sending it, so two wakes at once send it once, and tries a failed one again after 15 minutes", async () => {
    const { a, b } = await season();
    mail.failFor.add(FAMILY_B.parent.email);
    const [one, two] = await Promise.all([sendDueReminders(at(WAKE)), sendDueReminders(at(WAKE))]);
    expect(one.sent + two.sent).toBe(1);
    expect(one.failed + two.failed).toBe(2);
    expect(to(a)).toHaveLength(1);
    mail.failFor.clear();
    expect(await sendDueReminders(at("2027-03-10T09:40:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await sendDueReminders(at("2027-03-10T09:46:00Z"))).toEqual({ sent: 2, failed: 0 });
    expect(to(b)).toHaveLength(2);
    expect(await sendDueReminders(at("2027-03-10T10:30:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect((await db.select().from(requirementReminder)).map((r) => r.outcome)).toEqual(["sent", "sent", "sent"]);
    // Each claim names the app's own family (stage 2 of the app-owned families spec).
    const [famA, famB] = [await recordOfCustomer(FAMILY_A.family.qboId, "family"), await recordOfCustomer(FAMILY_B.family.qboId, "family")];
    expect((await db.select().from(requirementReminder)).map((r) => r.familyId === famA ? "A" : r.familyId === famB ? "B" : "?").sort()).toEqual(["A", "B", "B"]);
    // What the Health page reads: the day, and what went and failed on it.
    expect(await lastDueReminders()).toMatchObject({ day: "2027-03-10", sent: 3, failed: 2, lastSentAt: "2027-03-10T09:46:00.000Z", lastFailedAt: "2027-03-10T09:30:00.000Z" });
  });

  it("adds up two wakes that note the day at once: neither's counts are lost", async () => {
    // Yesterday's record: whichever wake writes first starts the new day, and the other adds to it.
    await db.insert(setting).values({ key: DUE_REMINDERS_KEY,
      value: { day: "2027-03-09", at: "2027-03-09T09:31:00.000Z", sent: 5, failed: 4, lastSentAt: "2027-03-09T09:30:00.000Z", lastFailedAt: "2027-03-09T09:31:00.000Z" } });
    // The record's row is held, so both wakes are at the record before either can write: the overlap is made, not hoped for.
    let release!: () => void, holding!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holds = new Promise<void>((resolve) => { holding = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(setting).where(eq(setting.key, DUE_REMINDERS_KEY)).for("update");
      holding();
      await held;
    });
    await holds;
    const one = db.transaction((tx) => noteLook(tx, "2027-03-10", { sent: 1, failed: 0 }, at("2027-03-10T09:30:00Z")));
    const two = db.transaction((tx) => noteLook(tx, "2027-03-10", { sent: 0, failed: 2 }, at("2027-03-10T09:31:00Z")));
    await untilALockIsAwaited(15_000, 2);
    release();
    await Promise.all([holder, one, two]);
    expect(await lastDueReminders()).toMatchObject({ day: "2027-03-10", sent: 1, failed: 2, lastSentAt: "2027-03-10T09:30:00.000Z", lastFailedAt: "2027-03-10T09:31:00.000Z" });
  });

  it("runs on the worker's wake, which says so when it sent something", async () => {
    await season();
    expect((await runDueJobs(at("2027-03-10T10:00:00Z"))).ran).toContainEqual({ job: DUE_REMINDERS_JOB, ok: true });
    expect((await runDueJobs(at("2027-03-10T10:01:00Z"))).ran.map((r) => r.job)).not.toContain(DUE_REMINDERS_JOB);
    expect(mail.outbox.filter((m) => m.subject.startsWith("Due "))).toHaveLength(3);
  });

  // Since stage 4's slice M8 a switch an Admin asks for reaches this clear (company-change-step5). Since slice M7a the clear
  // a change of company runs keeps the seasons' records (open question 16): it was "forgets every claim" while the
  // clear removed the families they name.
  it("keeps every claim in the clear a change of company would run, as the families they name are kept", async () => {
    await season();
    expect(await sendDueReminders(at(WAKE))).toEqual({ sent: 3, failed: 0 });
    const claims = await db.select().from(requirementReminder).orderBy(requirementReminder.id);
    expect(claims).toHaveLength(3);
    expect(await clearRosterOfOtherCompany("2222", { actor: { door: "system", id: null, label: "test" }, ip: null })).toBe(true);
    expect(await db.select().from(requirementReminder).orderBy(requirementReminder.id)).toEqual(claims);
    expect(await audits("season.records.cleared")).toEqual([]);
  });
});
