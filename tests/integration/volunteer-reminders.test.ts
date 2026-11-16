import { describe, it, expect, beforeEach, vi } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], failFor: new Set<string>() }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => {
  if (mail.failFor.has(m.to)) throw new Error("refused");
  mail.outbox.push(m);
} }));

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, requirement, requirementProgress, setting, volunteerReminder } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { getParentSettings, putParentSettings } from "@/lib/parents/settings";
import { REMINDER_BATCH, REMINDERS_JOB, sendVolunteerReminders } from "@/lib/volunteer/reminders";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { seedEvent, seedOutsideCredit, seedSignup } from "../helpers/volunteer";

/**
 * The volunteer reminders the worker sends (v1 spec §11.3): the day before a shift, from 9:00 on the club's clock, to
 * the guardian who took each place; and nudges 14 and 3 days before a required volunteer requirement is due, to the
 * guardians of each family that hasn't met it. A few per wake, each claimed before it is sent, each only once, and
 * nothing while the switches are off. No email names another family or shows a staff note.
 */
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const setZone = (timeZone: string) => db.insert(setting).values({ key: "club", value: { timeZone } }).onConflictDoUpdate({ target: setting.key, set: { value: { timeZone } } });
const switches = async (o: { signin?: boolean; welcome?: boolean }) => {
  const s = await getParentSettings();
  await db.transaction((tx) => putParentSettings(tx, { ...s, ...o }));
};
const to = (who: SeededParent) => mail.outbox.filter((m) => m.to === who.spec.parent.email);
const [AURELIO, AZALEA] = FAMILY_A.students, [BARNABY, BEATRIX] = FAMILY_B.students;
const MARCH_11 = "2027-03-11";
const at = (iso: string) => new Date(iso);

vi.setConfig({ testTimeout: 30_000 });
beforeEach(async () => { await resetDb(); mail.outbox.length = 0; mail.failFor.clear(); });

describe("the day-before reminder", () => {
  async function tomorrow() {
    const { a, b } = await seedTwoFamilies();
    await seedWorkingMail();
    const { shifts: [shift] } = await seedEvent({ name: "Spring concert ushers", onDate: MARCH_11, location: "Auditorium lobby", contactName: "Pat Organizer", shifts: [{ startsAt: "18:00", endsAt: "20:00", role: "Ushers" }] });
    await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO! });
    await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_B.family.qboId, signedUpBy: b.identity.parentId, guardianName: FAMILY_B.parent.name });
    await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_B.family.qboId, signedUpBy: b.identity.parentId, student: BARNABY!, cancelled: true });
    return { a, b, shift: shift! };
  }

  it("goes from 9:00 on the club's clock on the day before, to the guardian who took each live place, about that place alone, and once only", async () => {
    const { a, b } = await tomorrow();
    expect(await sendVolunteerReminders(at("2027-03-10T08:59:59Z"))).toEqual({ sent: 0, failed: 0 });
    // The shift's own day is too late, and two days before too early.
    expect(await sendVolunteerReminders(at("2027-03-11T10:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await sendVolunteerReminders(at("2027-03-09T10:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await sendVolunteerReminders(at("2027-03-10T09:00:00Z"))).toEqual({ sent: 2, failed: 0 });
    expect(mail.outbox.map((m) => m.subject)).toEqual(["Tomorrow: Spring concert ushers", "Tomorrow: Spring concert ushers"]);
    const [forA] = to(a), [forB] = to(b);
    expect(forA!.text).toContain(`A friendly reminder: ${AURELIO!.name} is helping at Spring concert ushers (Ushers) tomorrow.`);
    expect(forA!.text).toContain("When: Thursday, March 11, 2027, 6:00 pm to 8:00 pm");
    expect(forA!.text).toContain("Where: Auditorium lobby");
    expect(forA!.text).toContain("Contact Pat Organizer (pat.organizer@club.example)");
    expect(forB!.text).toContain("A friendly reminder: you're helping at Spring concert ushers (Ushers) tomorrow.");
    // Nothing of the other family, nor of a cancelled place.
    for (const name of [FAMILY_B.family.name, FAMILY_B.parent.name, BARNABY!.name]) expect(forA!.text).not.toContain(name);
    for (const name of [FAMILY_A.family.name, AURELIO!.name]) expect(forB!.text).not.toContain(name);
    expect(await sendVolunteerReminders(at("2027-03-10T15:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(mail.outbox).toHaveLength(2);
    expect(await audits("volunteer.reminders.sent")).toMatchObject([{ after: { kind: "day_before", onDate: MARCH_11, sent: 2, failed: 0 } }]);
  });

  it("reads 9:00 and tomorrow in the club's zone", async () => {
    await setZone("America/Chicago");
    await tomorrow();
    // 8:59 am CST on March 10 is 14:59 UTC.
    expect(await sendVolunteerReminders(at("2027-03-10T14:59:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await sendVolunteerReminders(at("2027-03-10T15:00:00Z"))).toEqual({ sent: 2, failed: 0 });
  });

  it("sends nothing while parent sign-ins are off or mail isn't working, nor to a blocked guardian", async () => {
    const { a } = await tomorrow();
    await switches({ signin: false });
    expect(await sendVolunteerReminders(at("2027-03-10T10:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    await switches({ signin: true });
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.identity.parentId));
    expect(await sendVolunteerReminders(at("2027-03-10T10:00:00Z"))).toEqual({ sent: 1, failed: 0 });
    expect(to(a)).toEqual([]);
    await db.delete(setting).where(eq(setting.key, "mail.status"));
    await db.update(parent).set({ blocked: false });
    expect(await sendVolunteerReminders(at("2027-03-10T11:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await db.select().from(volunteerReminder)).toHaveLength(1);
  });

  it("sends a few per wake, each claimed first, and tries a failed one again only after a while", async () => {
    const { a, b } = await tomorrow();
    // Five more shifts the same evening, each with a place for A's guardian: seven places in all.
    for (const startsAt of ["10:00", "11:00", "12:00", "13:00", "14:00"]) {
      const { shifts: [s] } = await seedEvent({ name: `Booth ${startsAt}`, onDate: MARCH_11, shifts: [{ startsAt, endsAt: `${String(Number(startsAt.slice(0, 2)) + 1)}:00` }] });
      await seedSignup({ shiftId: s!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    }
    mail.failFor.add(FAMILY_B.parent.email);
    const first = await sendVolunteerReminders(at("2027-03-10T09:00:00Z"));
    expect(first.sent + first.failed).toBe(REMINDER_BATCH);
    const second = await sendVolunteerReminders(at("2027-03-10T09:01:00Z"));
    expect(second.sent + second.failed).toBe(2);
    expect([first, second].reduce((n, r) => n + r.failed, 0)).toBe(1);
    // Two wakes at once never send one twice; the failed one waits 15 minutes before it is tried again.
    await Promise.all([sendVolunteerReminders(at("2027-03-10T09:05:00Z")), sendVolunteerReminders(at("2027-03-10T09:05:00Z"))]);
    expect(to(a)).toHaveLength(6);
    expect(new Set(to(a).map((m) => m.text)).size).toBe(6);
    mail.failFor.clear();
    expect(await sendVolunteerReminders(at("2027-03-10T09:20:00Z"))).toEqual({ sent: 1, failed: 0 });
    expect(to(b)).toHaveLength(1);
    expect(await sendVolunteerReminders(at("2027-03-10T09:40:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect((await db.select().from(volunteerReminder)).map((r) => r.outcome)).toEqual(Array(7).fill("sent"));
  });
});

describe("the nudges before a due date", () => {
  /**
   * In the season seedTwoFamilies() makes current: a required per-family requirement of two shifts due in 14 days (A
   * has met it with outside credit, B has not), and a required per-student requirement of one shift due in 3 days (A's
   * first student waived, with a reason; nobody has met it). Today is March 10, 2027.
   */
  async function due() {
    const { a, b } = await seedTwoFamilies();
    await seedWorkingMail();
    const [step] = await db.select().from(requirement).where(eq(requirement.title, "Handbook read"));
    const values = { stepId: step!.stepId, kind: "volunteer" as const, required: true, covers: "everyone" as const, amountUnit: "shifts" as const };
    const [family] = await db.insert(requirement).values({ ...values, title: "Two family shifts QR01", appliesTo: "family", amount: 2, dueOn: "2027-03-24", position: 50 }).returning();
    const [own] = await db.insert(requirement).values({ ...values, title: "One shift each QR02", appliesTo: "student", amount: 1, dueOn: "2027-03-13", position: 51 }).returning();
    await db.insert(requirement).values({ ...values, title: "Optional shifts QR03", required: false, appliesTo: "family", amount: 1, dueOn: "2027-03-24", position: 52 });
    await seedOutsideCredit({ familyQboId: FAMILY_A.family.qboId, requirementId: family!.id, shifts: 2, note: "Ran the bake sale QR04" });
    await db.insert(requirementProgress).values({ requirementId: own!.id, subjectQboId: AURELIO!.qboId, waivedAt: new Date(), waivedBy: null, waivedReason: "Has a broken wrist QR05" });
    await switches({ welcome: true });
    return { a, b };
  }

  it("emails each family that hasn't met one, once per nudge, with only its own requirements and where each stands", async () => {
    const { a, b } = await due();
    expect(await sendVolunteerReminders(at("2027-03-10T09:30:00Z"))).toEqual({ sent: 3, failed: 0 });
    expect(mail.outbox.map((m) => [m.to, m.subject]).sort()).toEqual([
      [FAMILY_A.parent.email, "Volunteering due Saturday, March 13, 2027"],
      [FAMILY_B.parent.email, "Volunteering due Saturday, March 13, 2027"],
      [FAMILY_B.parent.email, "Volunteering due Wednesday, March 24, 2027"],
    ].sort());
    const forA = to(a)[0]!.text;
    expect(forA).toContain("is due Saturday, March 13, 2027, 3 days from now.");
    expect(forA).toContain(`One shift each QR02: 0 of 1 shift done. ${AZALEA!.name} must do it.`);
    expect(forA).not.toContain(AURELIO!.name); // waived
    const fourteen = to(b).find((m) => m.subject.includes("March 24"))!.text;
    expect(fourteen).toContain("14 days from now");
    expect(fourteen).toContain("Two family shifts QR01: 0 of 2 shifts done. Anyone in your family can do it.");
    expect(fourteen).not.toContain("Optional shifts QR03");
    const three = to(b).find((m) => m.subject.includes("March 13"))!.text;
    expect(three).toContain(`${BARNABY!.name} must do it`);
    expect(three).toContain(`${BEATRIX!.name} must do it`);
    // Nothing of the other family, and no note or reason staff wrote.
    const all = mail.outbox.map((m) => m.text + m.html).join(" ");
    for (const secret of ["Ran the bake sale QR04", "Has a broken wrist QR05", ...b.season!.staffOnly, ...a.season!.staffOnly]) expect(all).not.toContain(secret);
    for (const m of to(a)) for (const name of [FAMILY_B.family.name, BARNABY!.name]) expect(m.text).not.toContain(name);
    for (const m of to(b)) for (const name of [FAMILY_A.family.name, AZALEA!.name]) expect(m.text).not.toContain(name);
    expect(await sendVolunteerReminders(at("2027-03-10T12:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await audits("volunteer.reminders.sent")).toMatchObject([{ after: { kind: "due", sent: 3, failed: 0 } }]);
  });

  it("goes only while parent sign-ins and welcome emails are both on, and not before 9:00", async () => {
    await due();
    await switches({ welcome: false });
    expect(await sendVolunteerReminders(at("2027-03-10T10:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    await switches({ welcome: true, signin: false });
    expect(await sendVolunteerReminders(at("2027-03-10T10:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    await switches({ signin: true });
    expect(await sendVolunteerReminders(at("2027-03-10T08:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    // Not on the days in between.
    expect(await sendVolunteerReminders(at("2027-03-09T10:00:00Z"))).toEqual({ sent: 0, failed: 0 });
    expect(await sendVolunteerReminders(at("2027-03-10T10:00:00Z"))).toEqual({ sent: 3, failed: 0 });
  });

  it("runs on the worker's wake, which says so when it sent something", async () => {
    await due();
    expect((await runDueJobs(at("2027-03-10T10:00:00Z"))).ran).toContainEqual({ job: REMINDERS_JOB, ok: true });
    expect((await runDueJobs(at("2027-03-10T10:01:00Z"))).ran.map((r) => r.job)).not.toContain(REMINDERS_JOB);
  });
});
