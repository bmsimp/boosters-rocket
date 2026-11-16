import { describe, it, expect, beforeEach, vi } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage, revalidatedPaths, signedOut } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string; attachments?: { filename: string; contentType: string; content: string }[] };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, requirement, role, roleAssignment, roleRule, setting, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { ADMIN_ONLY, GRANTABLE } from "@/lib/permissions/registry";
import { loadMyVolunteering } from "@/lib/volunteer/my-volunteer";
import { VOLUNTEER_SETTINGS_KEY } from "@/lib/volunteer/settings";
import VolunteerEventsPage from "@/app/staff/(app)/volunteer/page";
import VolunteerEventPage from "@/app/staff/(app)/volunteer/[id]/page";
import RequirementPage from "@/app/staff/(app)/seasons/[id]/requirements/[requirementId]/page";
import RequirementProgressPage from "@/app/staff/(app)/seasons/progress/[requirementId]/page";
import { addRequirementAction } from "@/app/staff/(app)/seasons/actions";
import {
  addShiftAction, cancelEventAction, cancelShiftAction, copyEventAction, createEventAction, saveCutoffAction, updateEventAction, updateShiftAction,
} from "@/app/staff/(app)/volunteer/actions";
import { resetDb, seedStaff, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedSignedInParent, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { dayFromNow, seedEvent } from "../helpers/volunteer";

/**
 * The staff side of volunteering (v1 spec §11.1): events and shifts, the sign-up lists, and the emails a change or a
 * cancellation sends. For every page and action: the guard and its permission, each argument checked, the audit row
 * in the write's own transaction with before and after, and who is emailed what.
 */
type Staff = Awaited<ReturnType<typeof seedStaff>>;
const BROWSER = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const NO_SUCH = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const audits = async (action?: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => !action || r.action === action);
const leaked = (text: string, markers: string[]) => markers.filter((m) => text.toLowerCase().includes(m.toLowerCase()));
const EVENT = { name: "Home game concessions", onDate: dayFromNow(30), location: "North stand", description: "Popcorn and pop.", contactName: "Pat Organizer", contactEmail: "Pat@Club.Example " };
const SHIFT = { startsAt: "18:00", endsAt: "21:00", places: 4, role: "Concessions", requirementIds: [] as string[] };

const withRole = async (email: string, name: string, patterns: string[]): Promise<Staff> => {
  const s = await seedStaff({ email, name });
  const [r] = await db.insert(role).values({ key: email, name }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};

let writer: Staff, reader: Staff, outsider: Staff;
vi.setConfig({ testTimeout: 30_000 });
beforeEach(async () => {
  await resetDb(); mail.outbox.length = 0;
  await seedWorkingMail();
  writer = await withRole("writer@club.org", "Wren Writer", ["Volunteer.*", "Season.*"]);
  reader = await withRole("reader@club.org", "Rae Reader", ["Volunteer.Event.Read"]);
  outsider = await withRole("outsider@club.org", "Ozzy Outsider", ["Roster.*", "Season.*"]);
  asStaff(writer);
});

/** Two families signed up for one shift, A with a student and B with its parent (seedTwoFamilies). */
const shared = async () => {
  const { a, b } = await seedTwoFamilies();
  const [shift] = await db.select().from(volunteerShift).where(eq(volunteerShift.id, a.volunteer!.shiftId));
  return { a, b, shift: shift!, eventId: shift!.eventId };
};
const mailTo = (who: SeededParent) => mail.outbox.filter((m) => m.to === who.spec.parent.email);

describe("the volunteer permissions and pages", () => {
  it("are two ordinary permissions a custom role can hold", () => {
    for (const p of ["Volunteer.Event.Read", "Volunteer.Event.ReadWrite"] as const) {
      expect(GRANTABLE).toContain(p);
      expect(ADMIN_ONLY).not.toContain(p);
    }
  });

  it("refuses every page and action to staff without the permission, and to a parent; one who may only read gets no action", async () => {
    const { shifts: [shift], event } = await seedEvent();
    const pages = [() => pageOutcome(VolunteerEventsPage), () => pageOutcome(VolunteerEventPage, { params: { id: event.id } })];
    const actions = [() => createEventAction(EVENT), () => updateEventAction(event.id, EVENT), () => copyEventAction(event.id, dayFromNow(40)), () => cancelEventAction(event.id),
      () => addShiftAction(event.id, SHIFT), () => updateShiftAction(shift!.id, SHIFT), () => cancelShiftAction(shift!.id), () => saveCutoffAction(24)];
    const snapshot = async () => JSON.stringify([await db.select().from(volunteerEvent), await db.select().from(volunteerShift), await db.select().from(setting).where(eq(setting.key, VOLUNTEER_SETTINGS_KEY))]);
    const before = await snapshot();
    for (const who of [outsider, reader]) {
      asStaff(who);
      for (const act of actions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    }
    asStaff(outsider);
    for (const page of pages) expect(await page()).toEqual({ redirect: "/refused" });
    asStaff(reader);
    for (const page of pages) expect("html" in (await page())).toBe(true);
    const parent = await seedSignedInParent();
    signedOut();
    asParent(parent.identity);
    for (const act of actions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    for (const page of pages) expect(await page()).toEqual({ redirect: "/staff/sign-in" });
    expect(await snapshot()).toBe(before);
    expect(revalidatedPaths()).toEqual([]);
    expect((await audits()).every((r) => r.action === "access.refused")).toBe(true);
  });

  it("lists the events, and a shift's sign-ups by name with their family, to a reader without the forms", async () => {
    await shared();
    await seedEvent({ name: "Last spring's car wash", onDate: dayFromNow(-200) });
    asStaff(reader);
    const list = textOf(await renderPage(VolunteerEventsPage));
    expect(list).toContain("Marching band car wash");
    expect(list).toContain("1 shift · 2 of 4 places filled");
    expect(list).toContain("Earlier events");
    expect(list).toContain("Last spring's car wash");
    expect(list).toContain("until 48 hours before the shift starts");
    expect(list).not.toContain("Add an event");
    const [event] = await db.select().from(volunteerEvent).where(eq(volunteerEvent.name, "Marching band car wash"));
    const page = textOf(await renderPage(VolunteerEventPage, { params: { id: event!.id } }));
    expect(page).toContain("2 of 4 places filled · 3 hours");
    expect(page).toContain(`${FAMILY_A.students[0]!.name} ${FAMILY_A.family.name}, signed up by ${FAMILY_A.parent.name}`);
    expect(page).toContain(`${FAMILY_B.parent.name} ${FAMILY_B.family.name}`);
    expect(page).not.toContain("Change or cancel this shift");
    // A list of many families, like the roster's: opening it is not audited.
    expect(await audits()).toEqual([]);
    for (const id of [NO_SUCH, "nope"]) expect(await pageOutcome(VolunteerEventPage, { params: { id } })).toEqual({ notFound: true });
  });
});

describe("events", () => {
  it("adds an event, checking what was typed, and audits it", async () => {
    expect(await createEventAction({ ...EVENT, name: " ", onDate: "2027-02-30", contactEmail: "nope", contactName: "" })).toEqual({ ok: false,
      errors: ["The event's name is needed.", "Who to contact is needed.", "Enter the event's date as a day on the calendar.", "The contact's email address doesn't look right."] });
    for (const bad of [null, "x", { ...EVENT, name: 7 }, { ...EVENT, location: "x".repeat(4001) }]) expect(await createEventAction(bad as never)).toEqual(BROWSER);
    const r = await createEventAction({ ...EVENT, extra: "ignored" } as never);
    expect(r).toMatchObject({ ok: true, message: "Event added. Add its shifts next." });
    const [e] = await db.select().from(volunteerEvent);
    expect(e).toMatchObject({ name: EVENT.name, onDate: EVENT.onDate, location: "North stand", description: "Popcorn and pop.", contactEmail: "pat@club.example", cancelledAt: null });
    expect((r as { eventId: string }).eventId).toBe(e!.id);
    const [audit] = await audits("volunteer.event.create");
    expect(audit).toMatchObject({ door: "staff", actorId: writer.id, permission: "Volunteer.Event.ReadWrite", targetType: "volunteer_event", targetId: e!.id });
    expect(revalidatedPaths()).toEqual(["/"]);
  });

  it("emails everyone signed up when the date or place changes, each about their own sign-up alone, and not for other changes", async () => {
    const { a, b, eventId, shift } = await shared();
    const [e] = await db.select().from(volunteerEvent).where(eq(volunteerEvent.id, eventId));
    const as = { name: e!.name, onDate: e!.onDate, location: e!.location, description: e!.description, contactName: e!.contactName, contactEmail: e!.contactEmail ?? "" };
    expect(await updateEventAction(eventId, { ...as, description: "Bring towels." })).toEqual({ ok: true, message: "Saved." });
    expect(mail.outbox).toEqual([]);
    const r = await updateEventAction(eventId, { ...as, onDate: dayFromNow(21), location: "Gym lot" });
    expect(r).toEqual({ ok: true, message: "Saved. All 2 people signed up have been emailed." });
    expect(mail.outbox).toHaveLength(2);
    for (const [who, other, whose] of [[a, b, `${FAMILY_A.students[0]!.name} is signed up`], [b, a, "You're signed up"]] as const) {
      const [m] = mailTo(who);
      expect(m!.subject).toBe("A volunteer shift has changed: Marching band car wash");
      expect(m!.text).toContain(whose);
      expect(m!.text).toContain("Where: Gym lot (it was Bandroom parking lot)");
      expect(m!.attachments![0]!.content).toContain("SEQUENCE:1");
      expect(leaked(JSON.stringify(m), other.markers)).toEqual([]);
    }
    const [after] = await db.select().from(volunteerShift).where(eq(volunteerShift.id, shift.id));
    expect(after!.revision).toBe(1);
    const [audit] = (await audits("volunteer.event.update")).slice(-1);
    expect(audit).toMatchObject({ before: { location: "Bandroom parking lot" }, after: { location: "Gym lot", signupsTold: 2 } });
    expect((await audits("volunteer.notice.sent")).map((x) => x.after)).toEqual([{ kind: "change", signups: expect.any(Array), sent: 2, failed: 0 }]);
  });

  it("copies an event to another day with its shifts and what they count toward, and nobody signed up", async () => {
    const { eventId, shift } = await shared();
    const fall = await seedSeason({ name: "Fall", current: false, steps: [{ name: "Volunteer" }] });
    const [r] = await db.insert(requirement).values({ stepId: Object.values(fall.stepIds)[0]!, kind: "volunteer", title: "Family shifts", appliesTo: "family", amount: 2, amountUnit: "shifts", position: 0 }).returning();
    await db.insert(volunteerShiftRequirement).values({ shiftId: shift.id, requirementId: r!.id });
    await db.insert(volunteerShift).values({ eventId, startsAt: "13:00", endsAt: "14:00", places: 2, cancelledAt: new Date() });
    expect(await copyEventAction(eventId, "not a date")).toEqual({ ok: false, errors: ["Enter the new event's date as a day on the calendar."] });
    const done = await copyEventAction(eventId, dayFromNow(27));
    expect(done).toMatchObject({ ok: true, message: "Copied, with its shifts. Nobody is signed up for the copy yet." });
    const copyId = (done as { eventId: string }).eventId;
    const shifts = await db.select().from(volunteerShift).where(eq(volunteerShift.eventId, copyId));
    expect(shifts.map((s) => [s.startsAt, s.endsAt, s.places, s.role, s.revision])).toEqual([["09:00:00", "12:00:00", 4, "Rinse crew", 0]]);
    expect(await db.select({ r: volunteerShiftRequirement.requirementId }).from(volunteerShiftRequirement).where(eq(volunteerShiftRequirement.shiftId, shifts[0]!.id))).toEqual([{ r: r!.id }]);
    expect(await db.select().from(volunteerSignup).where(eq(volunteerSignup.shiftId, shifts[0]!.id))).toEqual([]);
    expect((await audits("volunteer.event.copy"))[0]).toMatchObject({ targetId: copyId, after: { copiedFrom: { id: eventId }, shifts: 1 } });
  });

  it("cancels an event: everyone signed up is emailed, parents no longer see it, and it can't be changed", async () => {
    const { a, b, eventId } = await shared();
    expect(await cancelEventAction(eventId)).toEqual({ ok: true, message: "The event is cancelled. Parents no longer see it. All 2 people signed up have been emailed." });
    expect(mail.outbox.map((m) => [m.to, m.subject]).sort()).toEqual([[FAMILY_A.parent.email, "Cancelled: Marching band car wash"], [FAMILY_B.parent.email, "Cancelled: Marching band car wash"]].sort());
    expect(mailTo(a)[0]!.text).toContain(`The club has cancelled Marching band car wash, so ${FAMILY_A.students[0]!.name} doesn't need to come.`);
    expect(mailTo(b)[0]!.text).toContain("so you don't need to come.");
    expect(leaked(JSON.stringify(mailTo(a)), b.markers)).toEqual([]);
    expect((await loadMyVolunteering({ ...a.identity })).events).toEqual([]);
    expect((await loadMyVolunteering({ ...a.identity })).signups.map((s) => s.cancel)).toEqual(["cancelled"]);
    expect(await cancelEventAction(eventId)).toEqual({ ok: false, errors: ["This event is cancelled already."] });
    expect(await addShiftAction(eventId, SHIFT)).toEqual({ ok: false, errors: ["This event is cancelled, so it can't be changed."] });
    expect((await audits("volunteer.event.cancel"))[0]).toMatchObject({ before: { cancelled: false }, after: { cancelled: true, shiftsOn: 1, signupsTold: 2 } });
    for (const bad of ["nope", NO_SUCH]) expect((await cancelEventAction(bad)).ok).toBe(false);
  });
});

describe("shifts", () => {
  it("adds a shift, checking its times, places and requirements, and audits it", async () => {
    const { event } = await seedEvent({ shifts: [] });
    const fall = await seedSeason({ name: "Fall", steps: [{ name: "Volunteer", requirements: [{ title: "A checklist item", appliesTo: "family" }] }] });
    const [vol] = await db.insert(requirement).values({ stepId: Object.values(fall.stepIds)[0]!, kind: "volunteer", title: "Hours", appliesTo: "student", amount: 6, amountUnit: "hours", position: 1 }).returning();
    expect(await addShiftAction(event.id, { ...SHIFT, endsAt: "18:00", places: 0 })).toEqual({ ok: false,
      errors: ["The shift starts and ends at the same time. Check the two times.", "Say how many places: a whole number from 1 to 500."] });
    expect(await addShiftAction(event.id, { ...SHIFT, startsAt: "6pm" })).toEqual({ ok: false, errors: ["Enter the start and the end as times of day."] });
    expect(await addShiftAction(event.id, { ...SHIFT, requirementIds: [fall.requirementIds["A checklist item"]!] })).toEqual({ ok: false,
      errors: ["A requirement in that list isn't there any more, or isn't a volunteering one. Reload the page and choose again."] });
    for (const bad of [{ ...SHIFT, requirementIds: ["nope"] }, { ...SHIFT, places: "4" }, { ...SHIFT, startsAt: "18:00:00:00" }, null]) expect(await addShiftAction(event.id, bad as never)).toEqual(BROWSER);
    expect(await addShiftAction(event.id, { ...SHIFT, startsAt: "22:00", endsAt: "01:00", requirementIds: [vol!.id] })).toEqual({ ok: true, message: "Shift added. Parents can sign up for it now." });
    const [s] = await db.select().from(volunteerShift);
    expect(s).toMatchObject({ startsAt: "22:00:00", endsAt: "01:00:00", places: 4, role: "Concessions" });
    expect((await audits("volunteer.shift.add"))[0]).toMatchObject({ targetId: s!.id, after: { startsAt: "22:00", endsAt: "01:00", places: 4, requirementIds: [vol!.id] } });
    const page = textOf(await renderPage(VolunteerEventPage, { params: { id: event.id } }));
    expect(page).toContain("10:00 pm to 1:00 am the next day, Concessions");
    expect(page).toContain("0 of 4 places filled · 3 hours");
    expect(page).toContain("Counts toward: Fall · Volunteer · Hours.");
  });

  it("emails the shift's sign-ups when its time changes, and keeps it from having fewer places than people", async () => {
    const { a, b, shift } = await shared();
    const as = { startsAt: "09:00", endsAt: "12:00", places: 4, role: "Rinse crew", requirementIds: [] };
    expect(await updateShiftAction(shift.id, { ...as, places: 1 })).toEqual({ ok: false, errors: ["2 people are signed up for this shift, so it needs at least 2 places."] });
    expect(await updateShiftAction(shift.id, { ...as, places: 2, role: "Soap crew" })).toEqual({ ok: true, message: "Saved." });
    expect(mail.outbox).toEqual([]);
    expect(await updateShiftAction(shift.id, { ...as, places: 2, startsAt: "10:00" })).toEqual({ ok: true, message: "Saved. All 2 people signed up have been emailed." });
    for (const who of [a, b]) expect(mailTo(who)[0]!.text).toContain("10:00 am to noon (it was ");
    expect(leaked(JSON.stringify(mailTo(a)), b.markers)).toEqual([]);
    expect(leaked(JSON.stringify(mailTo(b)), a.markers)).toEqual([]);
    const rows = await audits("volunteer.shift.update");
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [expect.objectContaining({ places: 4, role: "Rinse crew" }), expect.objectContaining({ places: 2, role: "Soap crew" })],
      [expect.objectContaining({ startsAt: "09:00" }), expect.objectContaining({ startsAt: "10:00", signupsTold: 2 })],
    ]);
  });

  it("cancels one shift: its sign-ups are emailed and its places no longer offered", async () => {
    const { a, b, shift, eventId } = await shared();
    const other = await db.insert(volunteerShift).values({ eventId, startsAt: "13:00", endsAt: "15:00", places: 2 }).returning();
    expect(await cancelShiftAction(shift.id)).toEqual({ ok: true, message: "The shift is cancelled. All 2 people signed up have been emailed." });
    expect(mailTo(a)[0]!.text).toContain("The club has cancelled a shift at Marching band car wash");
    expect(mailTo(b)).toHaveLength(1);
    expect((await loadMyVolunteering({ ...a.identity })).events.flatMap((e) => e.shifts.map((s) => s.id))).toEqual([other[0]!.id]);
    expect(await cancelShiftAction(shift.id)).toEqual({ ok: false, errors: ["This shift is cancelled already."] });
    expect(await updateShiftAction(shift.id, SHIFT)).toEqual({ ok: false, errors: ["This shift is cancelled, so it can't be changed."] });
  });

  it("tells nobody the club has cut off from the family: a guardian whose link is closed, or who is blocked", async () => {
    const { a, b, shift, eventId } = await shared();
    await db.update(guardian).set({ status: "disabled" }).where(and(eq(guardian.parentId, a.identity.parentId), eq(guardian.familyQboId, FAMILY_A.family.qboId)));
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, b.identity.parentId));
    const as = { startsAt: "10:00", endsAt: "12:00", places: 4, role: "Rinse crew", requirementIds: [] };
    expect(await updateShiftAction(shift.id, as)).toEqual({ ok: true, message: "Saved." });
    expect(await cancelEventAction(eventId)).toMatchObject({ ok: true });
    expect(mail.outbox).toEqual([]);
    expect((await audits("volunteer.event.cancel"))[0]).toMatchObject({ after: { signupsTold: 0 } });
  });

  it("emails nobody about a shift that is over, saves its edits quietly, and won't cancel it", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { event, shifts: [over] } = await seedEvent({ onDate: dayFromNow(-3), location: "North stand", shifts: [{ startsAt: "09:00", endsAt: "12:00" }] });
    const [signup] = await db.insert(volunteerSignup).values({ shiftId: over!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, fillerKind: "guardian", fillerParentId: a.identity.parentId, fillerName: FAMILY_A.parent.name }).returning();
    const as = { name: event.name, onDate: event.onDate, location: "South stand", description: event.description, contactName: event.contactName, contactEmail: event.contactEmail ?? "" };
    expect(await updateEventAction(event.id, as)).toEqual({ ok: true, message: "Saved." });
    expect(await updateShiftAction(over!.id, { startsAt: "09:30", endsAt: "12:00", places: over!.places, role: "", requirementIds: [] })).toMatchObject({ ok: true });
    expect(await cancelShiftAction(over!.id)).toEqual({ ok: false, errors: ["This shift is over, so it can't be cancelled. Its volunteers keep what they signed up for."] });
    expect(await cancelEventAction(event.id)).toEqual({ ok: false, errors: ["Some of this event's shifts are over, so the event can't be cancelled as a whole. Cancel the shifts still to come one by one."] });
    expect(mail.outbox).toEqual([]);
    const [still] = await db.select().from(volunteerShift).where(eq(volunteerShift.id, over!.id));
    expect(still!.cancelledAt).toBeNull();
    expect((await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, signup!.id)))[0]!.cancelledAt).toBeNull();
  });

  it("tells staff when an email couldn't go", async () => {
    const { eventId } = await shared();
    await db.delete(setting).where(eq(setting.key, "mail"));
    expect(await cancelEventAction(eventId)).toEqual({ ok: true, message: "The event is cancelled. Parents no longer see it. 0 emailed; 2 couldn't be emailed (see Mail under Settings)." });
  });
});

describe("the cut-off and the volunteer kind of requirement", () => {
  it("saves the cancelling cut-off, a whole number of hours", async () => {
    expect(await saveCutoffAction(-1)).toEqual({ ok: false, errors: ["Enter the cut-off as a whole number of hours, from 0 to 720."] });
    expect(await saveCutoffAction(2.5)).toMatchObject({ ok: false });
    expect(await saveCutoffAction("24" as never)).toEqual(BROWSER);
    expect(await saveCutoffAction(24)).toEqual({ ok: true, message: "Saved." });
    const [row] = await db.select().from(setting).where(eq(setting.key, VOLUNTEER_SETTINGS_KEY));
    expect(row!.value).toEqual({ cutoffHours: 24 });
    expect((await audits("volunteer.settings.save"))[0]).toMatchObject({ before: { cutoffHours: null }, after: { cutoffHours: 24 } });
    expect(textOf(await renderPage(VolunteerEventsPage))).toContain("until 24 hours before the shift starts");
  });

  it("lets staff make a volunteer requirement, shows the shifts that count toward it, and where each family stands", async () => {
    const { shift } = await shared();
    const fall = await seedSeason({ name: "Fall", current: false, steps: [{ name: "Volunteer" }] });
    expect(await addRequirementAction(Object.values(fall.stepIds)[0]!, "volunteer", "family", { title: "Two family shifts", required: true, amount: 2, amountUnit: "shifts", dueOn: null }))
      .toMatchObject({ ok: true });
    const [r] = await db.select().from(requirement).where(eq(requirement.title, "Two family shifts"));
    await db.insert(volunteerShiftRequirement).values({ shiftId: shift.id, requirementId: r!.id });
    const page = textOf(await renderPage(RequirementPage, { params: { id: fall.seasonId, requirementId: r!.id } }));
    expect(page).toContain("Shifts that count toward it");
    expect(page).toContain("Marching band car wash");
    expect(page).toContain("9:00 am to noon");
    const progress = textOf(await renderPage(RequirementProgressPage, { params: { requirementId: r!.id } }));
    expect(progress).toContain("0 of 2 shifts done, signed up for 1");
  });
});
