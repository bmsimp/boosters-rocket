import { describe, it, expect, beforeEach, vi } from "vitest";
import { asParent, renderPage, revalidatedPaths } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string; attachments?: { filename: string; contentType: string; content: string }[] };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, qboCustomer, requirement, setting, volunteerSignup } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import type { ParentCtx } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { loadMySeason } from "@/lib/seasons/my-season";
import { cancelMySignup, loadMyVolunteering, loadShiftForMe, signUpForShift } from "@/lib/volunteer/my-volunteer";
import { VOLUNTEER_SETTINGS_KEY } from "@/lib/volunteer/settings";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import ShiftPage from "@/app/(parent)/volunteer/shifts/[id]/page";
import { cancelSignupAction, signUpAction } from "@/app/(parent)/volunteer/actions";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedSignedInParent, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { addToCache, stu } from "../helpers/roster-cache";
import { seedSeason } from "../helpers/season";
import { TWO_FAMILY_EVENT, seedEvent, seedShift, seedSignup } from "../helpers/volunteer";

/**
 * Volunteering as a parent does it (v1 spec §11.2, §12 invariant 7): the Volunteer page and a shift's page, signing up
 * and cancelling. Of other families a parent gets the number of places filled and nothing else. Every id that comes
 * from the browser (a shift, a sign-up, the student who fills a place) is tried with the other family's.
 */
const ctxOf = (identity: ParentIdentity): ParentCtx => ({ ...identity, ip: "203.0.113.50" });
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
const leaked = (text: string, markers: string[]) => markers.filter((m) => text.toLowerCase().includes(m.toLowerCase()));
const signups = () => db.select().from(volunteerSignup).orderBy(asc(volunteerSignup.createdAt));
const live = () => db.select().from(volunteerSignup).where(isNull(volunteerSignup.cancelledAt));
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const setZone = (timeZone: string) => db.insert(setting).values({ key: "club", value: { timeZone } }).onConflictDoUpdate({ target: setting.key, set: { value: { timeZone } } });
const NOT_FROM_PAGE = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const NOT_OFFERED = { ok: false, errors: ["That shift isn't open for sign-up any more. Reload the page to see what's open."] };
const NO_SUCH = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
const [AURELIO, AZALEA] = FAMILY_A.students, [BARNABY] = FAMILY_B.students;
const famOf = async (who: SeededParent) => (await loadMyFamily(ctxOf(who.identity)))!;
/** An event on a fixed day, for tests that pass the time it is. */
const MARCH_10 = "2027-03-10";

// Each test seeds two families with a season and money: on a machine running other suites that has taken over 5 seconds.
vi.setConfig({ testTimeout: 30_000 });
beforeEach(async () => { await resetDb(); mail.outbox.length = 0; });

describe("invariant 7: each parent sees only a count and their own sign-up", () => {
  it("shows both families the shift they share with its count, and each only its own sign-up", async () => {
    const { a, b } = await seedTwoFamilies();
    for (const [viewer, other, own] of [[a, b, `${AURELIO!.name} is doing this one`], [b, a, "You're doing this one"]] as const) {
      asParent(viewer.identity);
      const page = textOf(await renderPage(VolunteerPage));
      expect(page).toContain(TWO_FAMILY_EVENT);
      expect(page).toContain("2 of 4 places filled");
      expect(page).toContain(own);
      expect(leaked(page, other.markers)).toEqual([]);
      const shift = textOf(await renderPage(ShiftPage, { params: { id: viewer.volunteer!.shiftId } }));
      expect(shift).toContain("2 of 4 places filled");
      expect(shift).toContain(`Signed up from your family: ${viewer === a ? AURELIO!.name : "you"}.`);
      expect(leaked(shift, other.markers)).toEqual([]);
      // What the pages are given, rendered or not: client components get some of it as props.
      const data = JSON.stringify([await loadMyVolunteering(ctxOf(viewer.identity)), await loadShiftForMe(ctxOf(viewer.identity), await famOf(viewer), viewer.volunteer!.shiftId)]);
      expect(leaked(data, other.markers)).toEqual([]);
      expect(data).not.toContain(other.identity.parentId);
    }
  });

  it("counts every family's places, but lists the family's own sign-ups alone", async () => {
    const { a, b } = await seedTwoFamilies();
    const forA = await loadMyVolunteering(ctxOf(a.identity)), forB = await loadMyVolunteering(ctxOf(b.identity));
    expect(forA.events.map((e) => e.shifts.map((s) => [s.filled, s.places]))).toEqual([[[2, 4]]]);
    expect(forB.events).toEqual(forA.events);
    expect(forA.signups.map((s) => s.who)).toEqual([AURELIO!.name]);
    expect(forB.signups.map((s) => s.who)).toEqual(["You"]);
  });
});

describe("signing up", () => {
  it("takes a place for the guardian, audits it, and emails them a confirmation with a calendar file", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedWorkingMail();
    const { event, shifts: [shift] } = await seedEvent({ name: "Fish fry", shifts: [{ places: 3, role: "Fryer" }] });
    asParent(a.identity);
    const r = await signUpAction(shift!.id, "me");
    expect(r).toEqual({ ok: true, message: "You're signed up. Thank you! We've emailed you the details, with a calendar file." });
    const [row] = await signups();
    expect(row).toMatchObject({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, fillerKind: "guardian", fillerParentId: a.identity.parentId,
      studentQboId: null, fillerName: FAMILY_A.parent.name, cancelledAt: null });
    const [audit] = await audits("volunteer.signup.create");
    expect(audit).toMatchObject({ door: "parent", actorId: a.identity.parentId, targetType: "volunteer_signup", targetId: row!.id, ip: "203.0.113.50" });
    expect(audit!.after).toMatchObject({ familyQboId: FAMILY_A.family.qboId, shiftId: shift!.id, event: "Fish fry", filler: { parentId: a.identity.parentId, name: FAMILY_A.parent.name } });
    expect(revalidatedPaths()).toContain("/");
    expect(mail.outbox.map((m) => m.to)).toEqual([FAMILY_A.parent.email]);
    const [m] = mail.outbox;
    expect(m!.subject).toBe("You're signed up: Fish fry");
    expect(m!.text).toContain("Thank you! You're signed up to help at Fish fry (Fryer).");
    expect(m!.text).toContain("Where: North stadium stand");
    expect(m!.text).toContain("Plans change? You can cancel on the portal until ");
    expect(m!.text).toContain("http://localhost:3000/volunteer");
    expect(m!.attachments).toHaveLength(1);
    expect(m!.attachments![0]).toMatchObject({ filename: "volunteer-shift.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH" });
    expect(m!.attachments![0]!.content).toContain(`UID:volunteer-signup-${row!.id}@booster-rocket`);
    // The club's zone is UTC until set: 18:00 on the event's day.
    const day = event.onDate.replaceAll("-", "");
    expect(m!.attachments![0]!.content).toContain(`\r\nDTSTART:${day}T180000Z\r\nDTEND:${day}T210000Z\r\n`);
    // The page now shows it, with the count.
    const page = textOf(await renderPage(VolunteerPage));
    expect(page).toContain("1 of 3 places filled");
    expect(page).toContain("You're doing this one");
    expect(page).toContain("Cancel my sign-up");
  });

  it("takes a place for one of the family's students, and shows beforehand what it counts toward for each person", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const seeded = await seedSeason({ name: "Fall", steps: [{ name: "Volunteer" }] });
    const [stepId] = Object.values(seeded.stepIds);
    const [family, hours] = await db.insert(requirement).values([
      { stepId: stepId!, kind: "volunteer", title: "Family shifts", appliesTo: "family", amount: 2, amountUnit: "shifts", position: 0 },
      { stepId: stepId!, kind: "volunteer", title: "Student hours", appliesTo: "student", amount: 6, amountUnit: "hours", position: 1 },
      { stepId: stepId!, kind: "volunteer", title: "Not linked", appliesTo: "family", amount: 1, amountUnit: "shifts", position: 2 },
    ]).returning();
    const { shifts: [shift] } = await seedEvent({ shifts: [{ startsAt: "09:00", endsAt: "12:00", requirementIds: [family!.id, hours!.id] }] });
    const view = (await loadShiftForMe(ctxOf(a.identity), await famOf(a), shift!.id))!;
    expect(view.choices.map((c) => [c.value, c.label, c.countsToward.map((t) => `${t.counts} toward ${t.title}: ${t.whoMust}; ${t.standing}`)])).toEqual([
      ["me", `Me (${FAMILY_A.parent.name})`, ["1 shift toward Family shifts: Anyone in your family can do it; 0 of 2 shifts done"]],
      [AURELIO!.qboId, AURELIO!.name, ["1 shift toward Family shifts: Anyone in your family can do it; 0 of 2 shifts done", `3 hours toward Student hours: ${AURELIO!.name} must do it; 0 of 6 hours done`]],
      [AZALEA!.qboId, AZALEA!.name, ["1 shift toward Family shifts: Anyone in your family can do it; 0 of 2 shifts done", `3 hours toward Student hours: ${AZALEA!.name} must do it; 0 of 6 hours done`]],
    ]);
    asParent(a.identity);
    expect(await signUpAction(shift!.id, AURELIO!.qboId)).toMatchObject({ ok: true, message: expect.stringContaining(`${AURELIO!.name} is signed up. Thank you!`) });
    expect((await signups())[0]).toMatchObject({ fillerKind: "student", studentQboId: AURELIO!.qboId, fillerName: AURELIO!.name, fillerParentId: null, signedUpBy: a.identity.parentId });
    // The season now says what the family is signed up for: the family's shift, and Aurelio's hours, not Azalea's.
    const season = (await loadMySeason(ctxOf(a.identity), (await famOf(a)).students))!;
    expect(season.steps[0]!.family.map((l) => [l.title, l.words])).toEqual([["Family shifts", "0 of 2 shifts done, signed up for 1"], ["Not linked", "0 of 1 shift done"]]);
    expect(season.steps[0]!.students.map((s) => [s.name, s.lines.map((l) => l.words)])).toEqual([[AURELIO!.name, ["0 of 6 hours done, signed up for 3"]], [AZALEA!.name, ["0 of 6 hours done"]]]);
    // The shift's page marks Aurelio as on it, and says so.
    const again = (await loadShiftForMe(ctxOf(a.identity), await famOf(a), shift!.id))!;
    expect(again.choices.map((c) => c.taken)).toEqual([false, true, false]);
    expect(again.mine).toEqual([{ who: AURELIO!.name }]);
  });

  it("never counts a place on a cancelled shift, a cancelled event or a cancelled sign-up", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const seeded = await seedSeason({ name: "Fall", steps: [{ name: "Volunteer" }] });
    const [r] = await db.insert(requirement).values({ stepId: Object.values(seeded.stepIds)[0]!, kind: "volunteer", title: "Family shifts", appliesTo: "family", amount: 3, amountUnit: "shifts", position: 0 }).returning();
    const on = await seedEvent({ shifts: [{ requirementIds: [r!.id] }, { requirementIds: [r!.id], cancelled: true }] });
    const off = await seedEvent({ cancelled: true, shifts: [{ requirementIds: [r!.id] }] });
    for (const shift of [...on.shifts, ...off.shifts]) await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: "x" });
    await seedSignup({ shiftId: on.shifts[0]!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO!, cancelled: true });
    const season = (await loadMySeason(ctxOf(a.identity), (await famOf(a)).students))!;
    expect(season.steps[0]!.family.map((l) => l.words)).toEqual(["0 of 3 shifts done, signed up for 1"]);
  });

  it("refuses a full shift, one that has started, and the same person twice", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [full, open] } = await seedEvent({ shifts: [{ places: 1 }, { places: 5 }] });
    await seedSignup({ shiftId: full!.id, familyQboId: "SOMEONE-ELSE", signedUpBy: NO_SUCH, guardianName: "Someone" });
    asParent(a.identity);
    expect(await signUpAction(full!.id, "me")).toEqual({ ok: false, errors: ["Sorry, that shift is full now. Every place has been taken."] });
    expect(await signUpAction(open!.id, AZALEA!.qboId)).toMatchObject({ ok: true });
    expect(await signUpAction(open!.id, AZALEA!.qboId)).toEqual({ ok: false, errors: [`${AZALEA!.name} is signed up for this shift already.`] });
    expect(await signUpAction(open!.id, "me")).toMatchObject({ ok: true });
    expect(await signUpAction(open!.id, "me")).toEqual({ ok: false, errors: ["You're signed up for this shift already."] });
    const today = await seedEvent({ onDate: MARCH_10, shifts: [{ startsAt: "10:00", endsAt: "12:00" }] });
    const at = new Date("2027-03-10T10:00:00Z");
    expect(await signUpForShift(ctxOf(a.identity), await famOf(a), today.shifts[0]!.id, "me", new Date(at.getTime() - 1000))).toMatchObject({ ok: true });
    expect(await signUpForShift(ctxOf(a.identity), await famOf(a), today.shifts[0]!.id, AURELIO!.qboId, at)).toEqual({ ok: false, errors: ["That shift has started, so it's too late to sign up for it."] });
    expect((await live()).length).toBe(4);
  });

  it("refuses a shift that isn't offered, and anything a page never sends", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [cancelledShift] } = await seedEvent({ shifts: [{ cancelled: true }] });
    const { shifts: [ofCancelledEvent] } = await seedEvent({ cancelled: true });
    const { shifts: [open] } = await seedEvent();
    asParent(a.identity);
    for (const shiftId of [NO_SUCH, cancelledShift!.id, ofCancelledEvent!.id]) expect(await signUpAction(shiftId, "me")).toEqual(NOT_OFFERED);
    for (const [shiftId, who] of [["not-a-uuid", "me"], [open!.id, ""], [open!.id, { qboId: AURELIO!.qboId }], [open!.id, "x".repeat(65)], [open!.id, null], [123, "me"]] as const) {
      expect(await signUpAction(shiftId as never, who as never)).toEqual(NOT_FROM_PAGE);
    }
    for (const id of [NO_SUCH, cancelledShift!.id, ofCancelledEvent!.id, "nope"]) expect(await loadShiftForMe(ctxOf(a.identity), await famOf(a), id)).toBeNull();
    expect(await signups()).toEqual([]);
  });

  it("signs up only the family's own active students: family B's student, an inactive one or the family itself are refused", async () => {
    const { a, b } = await seedTwoFamilies();
    await addToCache([stu("QBO-ALDERQUIST-STUDENT-7999", "Gone Alderquist (deleted)", FAMILY_A.family.qboId, { active: false })]);
    const { shifts: [shift] } = await seedEvent({ name: "Bake sale" });
    asParent(a.identity);
    for (const who of [BARNABY!.qboId, FAMILY_B.parent.qboId, FAMILY_B.family.qboId, "QBO-ALDERQUIST-STUDENT-7999", FAMILY_A.family.qboId, FAMILY_A.parent.qboId, b.identity.parentId]) {
      expect(await signUpAction(shift!.id, who), who).toEqual(NOT_FROM_PAGE);
    }
    expect((await signups()).filter((s) => s.shiftId === shift!.id)).toEqual([]);
    // A student QuickBooks has moved to another family since the page was drawn is refused too.
    const family = await famOf(a);
    await db.update(qboCustomer).set({ parentQboId: FAMILY_B.family.qboId }).where(eq(qboCustomer.qboId, AZALEA!.qboId));
    expect(await signUpForShift(ctxOf(a.identity), family, shift!.id, AZALEA!.qboId)).toEqual(NOT_FROM_PAGE);
    expect((await signups()).filter((s) => s.shiftId === shift!.id)).toEqual([]);
  });

  it("leaves exactly as many people signed up as there are places when they all take them at the same moment", async () => {
    const a = await seedSignedInParent(FAMILY_A), b = await seedSignedInParent(FAMILY_B);
    const [famA, famB] = [await famOf(a), await famOf(b)];
    let shiftId = "";
    const people = [
      () => signUpForShift(ctxOf(a.identity), famA, shiftId, "me"), () => signUpForShift(ctxOf(b.identity), famB, shiftId, "me"),
      ...FAMILY_A.students.map((s) => () => signUpForShift(ctxOf(a.identity), famA, shiftId, s.qboId)),
      ...FAMILY_B.students.map((s) => () => signUpForShift(ctxOf(b.identity), famB, shiftId, s.qboId)),
    ];
    for (const places of [1, 1, 1, 2, 3]) {
      shiftId = (await seedShift((await seedEvent({ shifts: [] })).event.id, { places })).id;
      // Six people from two families, each on their own connection, all at once.
      const results = await Promise.all(people.map((go) => go()));
      expect(results.filter((r) => r.ok)).toHaveLength(places);
      expect(results.filter((r) => !r.ok).map((r) => (r as { errors: string[] }).errors)).toEqual(Array(6 - places).fill(["Sorry, that shift is full now. Every place has been taken."]));
      expect(await db.select().from(volunteerSignup).where(and(eq(volunteerSignup.shiftId, shiftId), isNull(volunteerSignup.cancelledAt)))).toHaveLength(places);
    }
  });
});

describe("cancelling", () => {
  // The shift starts at 18:00 on March 10 in the club's zone; the cut-off is 48 hours before.
  const seedOwn = async () => {
    const a = await seedSignedInParent(FAMILY_A), b = await seedSignedInParent(FAMILY_B);
    const { event, shifts: [shift] } = await seedEvent({ onDate: MARCH_10, contactName: "Pat Organizer", contactEmail: "pat@club.example", shifts: [{ startsAt: "18:00", endsAt: "21:00" }] });
    const mine = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO! });
    const theirs = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_B.family.qboId, signedUpBy: b.identity.parentId, guardianName: FAMILY_B.parent.name });
    return { a, b, event, shift: shift!, mine, theirs };
  };

  it("cancels the family's own sign-up until the cut-off, to the second, and not at it", async () => {
    const { a, mine } = await seedOwn();
    const cutoff = new Date("2027-03-08T18:00:00Z");
    expect(await cancelMySignup(ctxOf(a.identity), await famOf(a), mine.id, cutoff)).toEqual({ ok: false,
      errors: ["It's too close to the shift to cancel here: the portal takes cancellations until 48 hours before it starts. Please contact Pat Organizer (pat@club.example)."] });
    expect((await live()).map((s) => s.id)).toContain(mine.id);
    expect(await cancelMySignup(ctxOf(a.identity), await famOf(a), mine.id, new Date(cutoff.getTime() - 1000))).toEqual({ ok: true,
      message: `Cancelled. ${AURELIO!.name}'s place is free for someone else now. Thanks for letting us know.` });
    const [row] = await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, mine.id));
    expect(row).toMatchObject({ cancelledByDoor: "parent", cancelledBy: a.identity.parentId });
    expect((await audits("volunteer.signup.cancel"))[0]).toMatchObject({ door: "parent", actorId: a.identity.parentId, targetId: mine.id, after: { cancelled: true } });
    expect(await cancelMySignup(ctxOf(a.identity), await famOf(a), mine.id, new Date(cutoff.getTime() - 1000))).toEqual({ ok: false, errors: ["That sign-up isn't there any more. Reload the page."] });
  });

  it("moves the cut-off with the club's setting and its time zone", async () => {
    const { a, mine } = await seedOwn();
    await setZone("America/Chicago"); // 18:00 CST on March 10 is 00:00 UTC on March 11
    await db.insert(setting).values({ key: VOLUNTEER_SETTINGS_KEY, value: { cutoffHours: 2 } });
    const v = await loadMyVolunteering(ctxOf(a.identity), new Date("2027-03-10T21:59:59Z"));
    expect(v.signups.map((s) => [s.cancel, s.cancelUntil])).toEqual([["open", "Wednesday, March 10, 4:00 pm"]]);
    expect(await cancelMySignup(ctxOf(a.identity), await famOf(a), mine.id, new Date("2027-03-10T22:00:00Z"))).toMatchObject({ ok: false });
    expect((await loadMyVolunteering(ctxOf(a.identity), new Date("2027-03-10T22:00:00Z"))).signups.map((s) => s.cancel)).toEqual(["closed"]);
    expect(await cancelMySignup(ctxOf(a.identity), await famOf(a), mine.id, new Date("2027-03-10T21:59:59Z"))).toMatchObject({ ok: true });
  });

  it("after the cut-off, the page says whom to contact and offers no button", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await db.insert(setting).values({ key: VOLUNTEER_SETTINGS_KEY, value: { cutoffHours: 720 } }); // 30 days: a shift 5 days away is past it
    const shift = await seedEvent({ inDays: 5, contactName: "Robin Lead", contactEmail: null, shifts: [{}] });
    await seedSignup({ shiftId: shift.shifts[0]!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    asParent(a.identity);
    const page = textOf(await renderPage(VolunteerPage));
    expect(page).toContain("It's less than 720 hours before the shift, so it can't be cancelled here. If you can't make it, please contact Robin Lead.");
    expect(page).not.toContain("Cancel my sign-up");
  });

  it("refuses family B's sign-up to family A's parent, as one that isn't there, and changes nothing", async () => {
    const { a, theirs } = await seedOwn();
    asParent(a.identity);
    for (const id of [theirs.id, NO_SUCH]) expect(await cancelSignupAction(id)).toEqual({ ok: false, errors: ["That sign-up isn't there any more. Reload the page."] });
    for (const bad of ["nope", 7, null, { id: theirs.id }]) expect(await cancelSignupAction(bad as never)).toEqual(NOT_FROM_PAGE);
    const [row] = await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, theirs.id));
    expect(row!.cancelledAt).toBeNull();
    expect(await audits("volunteer.signup.cancel")).toEqual([]);
  });

  it("says when the club has cancelled the shift, and has nothing to cancel", async () => {
    const { a } = await seedOwn();
    const later = await seedEvent({ inDays: 10, shifts: [{ cancelled: true }] });
    const s = await seedSignup({ shiftId: later.shifts[0]!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    expect(await cancelMySignup(ctxOf(a.identity), await famOf(a), s.id)).toEqual({ ok: false, errors: ["The club has cancelled this shift, so there's nothing to cancel."] });
    const v = await loadMyVolunteering(ctxOf(a.identity));
    expect(v.signups.find((x) => x.id === s.id)?.cancel).toBe("cancelled");
    expect(v.events.flatMap((e) => e.shifts.map((x) => x.id))).not.toContain(later.shifts[0]!.id);
  });
});

describe("the club's day and hour", () => {
  it("lists a shift until it ends, by the club's clock, and offers it only until it starts", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedEvent({ onDate: MARCH_10, shifts: [{ startsAt: "10:00", endsAt: "12:00", places: 2 }] });
    const shiftsAt = async (iso: string) => (await loadMyVolunteering(ctxOf(a.identity), new Date(iso))).events.flatMap((e) => e.shifts.map((s) => s.state));
    expect(await shiftsAt("2027-03-10T09:59:59Z")).toEqual(["open"]);
    expect(await shiftsAt("2027-03-10T10:00:00Z")).toEqual(["started"]);
    expect(await shiftsAt("2027-03-10T11:59:59Z")).toEqual(["started"]);
    expect(await shiftsAt("2027-03-10T12:00:00Z")).toEqual([]);
  });

  it("reads the same event's day in the club's own zone: at one instant it is over in Kiritimati and still to come in Pago Pago", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [shift] } = await seedEvent({ onDate: MARCH_10, shifts: [{ startsAt: "10:00", endsAt: "11:00" }] });
    const now = new Date("2027-03-09T21:30:00Z");
    await setZone("Pacific/Kiritimati"); // UTC+14: the shift ran 20:00 to 21:00 UTC on March 9
    expect((await loadMyVolunteering(ctxOf(a.identity), now)).events).toEqual([]);
    expect(await signUpForShift(ctxOf(a.identity), await famOf(a), shift!.id, "me", now)).toEqual({ ok: false, errors: ["That shift has started, so it's too late to sign up for it."] });
    await setZone("Pacific/Pago_Pago"); // UTC-11: it runs 21:00 to 22:00 UTC on March 10
    expect((await loadMyVolunteering(ctxOf(a.identity), now)).events.flatMap((e) => e.shifts.map((s) => s.state))).toEqual(["open"]);
    expect(await signUpForShift(ctxOf(a.identity), await famOf(a), shift!.id, "me", now)).toMatchObject({ ok: true });
  });

  it("keeps an overnight shift listed past midnight, until it ends the next morning", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedEvent({ onDate: MARCH_10, shifts: [{ startsAt: "22:00", endsAt: "02:00" }] });
    const at = async (iso: string) => (await loadMyVolunteering(ctxOf(a.identity), new Date(iso))).events.flatMap((e) => e.shifts.map((s) => [s.timeWords, s.state]));
    expect(await at("2027-03-11T01:59:59Z")).toEqual([["10:00 pm to 2:00 am the next day", "started"]]);
    expect(await at("2027-03-11T02:00:00Z")).toEqual([]);
  });
});

describe("a change of QuickBooks company", () => {
  it("deletes every sign-up, cancelled ones too, and keeps the events and shifts", async () => {
    const { a } = await seedTwoFamilies();
    await seedSignup({ shiftId: a.volunteer!.shiftId, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AZALEA!, cancelled: true });
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    expect(await clearRosterOfOtherCompany("9130000000000002", { actor: { door: "staff", id: null, label: "admin" }, ip: null })).toBe(true);
    expect(await signups()).toEqual([]);
    const [audit] = await audits("volunteer.signups.cleared");
    expect(audit!.after).toEqual({ reason: "different_company", realmId: "9130000000000002", signups: 2, cancelledSignups: 1 });
  });
});
