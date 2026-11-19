import { describe, it, expect, beforeEach, vi } from "vitest";
import { asParent, renderPage, revalidatedPaths } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string; attachments?: { filename: string; contentType: string; content: string }[] };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family as familyTable, qboCustomer, requirement, setting, volunteerCredit, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import type { ParentCtx } from "@/lib/guards";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { loadMySeason } from "@/lib/seasons/my-season";
import { cancelMySignup, loadMyVolunteering, loadShiftForMe, signUpForShift } from "@/lib/volunteer/my-volunteer";
import { checkIn, loadCheckInForMe } from "@/lib/volunteer/check-in";
import { loadMyCredit } from "@/lib/volunteer/credit";
import { VOLUNTEER_SETTINGS_KEY } from "@/lib/volunteer/settings";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import ShiftPage from "@/app/(parent)/volunteer/shifts/[id]/page";
import { cancelSignupAction, signUpAction } from "@/app/(parent)/volunteer/actions";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { addToCache, moveInCache, stu } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { seedSeason } from "../helpers/season";
import { TWO_FAMILY_EVENT, seedEvent, seedOutsideCredit, seedShift, seedSignup, shiftAround } from "../helpers/volunteer";

/**
 * Volunteering as a parent does it (v1 spec §11.2, §12 invariant 7): the Volunteer page and a shift's page, signing up
 * and cancelling. Of other families a parent gets the number of places filled and nothing else. Every id that comes
 * from the browser (a shift, a sign-up, the student who fills a place, by the app's own id) is tried with the other
 * family's. Sign-ups name the app's own families and students (stage 2 of the app-owned families spec).
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
/** The app's own records of a fixture's family or student: what a sign-up names, and what a page sends for a student. */
const familyId = (qboId: string) => recordOfCustomer(qboId, "family");
const studentId = (qboId: string) => recordOfCustomer(qboId, "student");
const studentChoice = async (s: { qboId: string }) => String(await studentId(s.qboId));
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
      expect(shift).toContain(`Signed up from your family: ${viewer === a ? `${AURELIO!.name} (checked in)` : "you"}.`);
      expect(leaked(shift, other.markers)).toEqual([]);
      // What the pages are given, rendered or not: client components get some of it as props.
      const data = JSON.stringify([await loadMyVolunteering(ctxOf(viewer.identity)), await loadShiftForMe(ctxOf(viewer.identity), viewer.volunteer!.shiftId)]);
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
    expect(row).toMatchObject({ shiftId: shift!.id, familyId: await familyId(FAMILY_A.family.qboId), signedUpBy: a.identity.parentId, fillerKind: "guardian", fillerParentId: a.identity.parentId,
      studentId: null, fillerName: FAMILY_A.parent.name, cancelledAt: null });
    const [audit] = await audits("volunteer.signup.create");
    expect(audit).toMatchObject({ door: "parent", actorId: a.identity.parentId, targetType: "volunteer_signup", targetId: row!.id, ip: "203.0.113.50" });
    // New audit rows name the app's own family (open question 17).
    expect(audit!.after).toMatchObject({ familyId: String(await familyId(FAMILY_A.family.qboId)), shiftId: shift!.id, event: "Fish fry", filler: { parentId: a.identity.parentId, name: FAMILY_A.parent.name } });
    expect(JSON.stringify(audit!.after)).not.toContain(FAMILY_A.family.qboId);
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
    const view = (await loadShiftForMe(ctxOf(a.identity), shift!.id))!;
    expect(view.choices.map((c) => [c.value, c.label, c.countsToward.map((t) => `${t.counts} toward ${t.title}: ${t.whoMust}; ${t.standing}`)])).toEqual([
      ["me", `Me (${FAMILY_A.parent.name})`, ["1 shift toward Family shifts: Anyone in your family can do it; 0 of 2 shifts done"]],
      [await studentChoice(AURELIO!), AURELIO!.name, ["1 shift toward Family shifts: Anyone in your family can do it; 0 of 2 shifts done", `3 hours toward Student hours: ${AURELIO!.name} must do it; 0 of 6 hours done`]],
      [await studentChoice(AZALEA!), AZALEA!.name, ["1 shift toward Family shifts: Anyone in your family can do it; 0 of 2 shifts done", `3 hours toward Student hours: ${AZALEA!.name} must do it; 0 of 6 hours done`]],
    ]);
    asParent(a.identity);
    // The page sends the student's app id, never a QuickBooks id.
    expect(view.choices.map((c) => c.value).join(" ")).not.toContain(AURELIO!.qboId);
    expect(await signUpAction(shift!.id, await studentChoice(AURELIO!))).toMatchObject({ ok: true, message: expect.stringContaining(`${AURELIO!.name} is signed up. Thank you!`) });
    expect((await signups())[0]).toMatchObject({ fillerKind: "student", studentId: await studentId(AURELIO!.qboId), fillerName: AURELIO!.name, fillerParentId: null, signedUpBy: a.identity.parentId });
    // The season now says what the family is signed up for: the family's shift, and Aurelio's hours, not Azalea's.
    const season = (await loadMySeason(ctxOf(a.identity)))!;
    expect(season.steps[0]!.family.map((l) => [l.title, l.words])).toEqual([["Family shifts", "0 of 2 shifts done, signed up for 1"], ["Not linked", "0 of 1 shift done"]]);
    expect(season.steps[0]!.students.map((s) => [s.name, s.lines.map((l) => l.words)])).toEqual([[AURELIO!.name, ["0 of 6 hours done, signed up for 3"]], [AZALEA!.name, ["0 of 6 hours done"]]]);
    // The shift's page marks Aurelio as on it, and says so.
    const again = (await loadShiftForMe(ctxOf(a.identity), shift!.id))!;
    expect(again.choices.map((c) => c.taken)).toEqual([false, true, false]);
    expect(again.mine).toEqual([{ who: AURELIO!.name, checkedIn: false }]);
  });

  it("a place another family took for a student who has since moved in is not counted or listed for the new family, and can't be taken twice", async () => {
    const a = await seedSignedInParent(FAMILY_A), b = await seedSignedInParent(FAMILY_B);
    const seeded = await seedSeason({ name: "Fall", steps: [{ name: "Volunteer" }] });
    const [hours] = await db.insert(requirement).values({ stepId: Object.values(seeded.stepIds)[0]!, kind: "volunteer", title: "Student hours", appliesTo: "student", amount: 6, amountUnit: "hours", position: 0 }).returning();
    const { shifts: [shift] } = await seedEvent({ shifts: [{ startsAt: "09:00", endsAt: "12:00", requirementIds: [hours!.id] }] });
    await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_B.family.qboId, signedUpBy: b.identity.parentId, student: BARNABY! });
    await moveInCache([BARNABY!.qboId], FAMILY_A.family.qboId); // as a move staff make leaves it: the app's records follow
    const season = (await loadMySeason(ctxOf(a.identity)))!;
    expect(season.steps[0]!.students.find((s) => s.name === BARNABY!.name)!.lines.map((l) => l.words)).toEqual(["0 of 6 hours done"]);
    const view = (await loadShiftForMe(ctxOf(a.identity), shift!.id))!;
    expect(view.mine).toEqual([]);
    const barnaby = await studentChoice(BARNABY!);
    expect(view.choices.find((c) => c.value === barnaby)!.taken).toBe(true);
    expect((await loadShiftForMe(ctxOf(b.identity), shift!.id))!.mine).toEqual([]);
  });

  it("says the club's list is being updated when a roster refresh holds the lock, rather than failing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [shift] } = await seedEvent({ shifts: [{}] });
    let taken!: () => void, letGo!: () => void;
    const holding = new Promise<void>((r) => { taken = r; }), until = new Promise<void>((r) => { letGo = r; });
    const refresh = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`); taken(); await until; });
    await holding;
    try {
      expect(await signUpForShift(ctxOf(a.identity), shift!.id, "me")).toEqual({ ok: false, errors: ["The club's list of families is being brought up to date just now. Please try again in a minute."] });
    } finally { letGo(); await refresh; }
    expect(await live()).toEqual([]);
  });

  it("says Full, Started and Signed up in plain words, never with the icons that mean done or waived", async () => {
    const a = await seedSignedInParent(FAMILY_A), b = await seedSignedInParent(FAMILY_B);
    const { shifts: [full, mine] } = await seedEvent({ shifts: [{ places: 1, startsAt: "09:00", endsAt: "10:00" }, { places: 3, startsAt: "11:00", endsAt: "12:00" }] });
    await seedSignup({ shiftId: full!.id, familyQboId: FAMILY_B.family.qboId, signedUpBy: b.identity.parentId, guardianName: FAMILY_B.parent.name });
    await seedSignup({ shiftId: mine!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    asParent(a.identity);
    const html = await renderPage(VolunteerPage);
    expect(html).toContain('<span class="state">Full</span>');
    expect(html).toContain('<span class="state">Signed up</span>');
    expect(html).not.toMatch(/class="state (done|waived)"/);
    const shift = await renderPage(ShiftPage, { params: { id: full!.id } });
    expect(textOf(shift)).toContain("This shift is full. Every place has been taken.");
    expect(shift).not.toMatch(/class="state (done|waived)"/);
  });

  it("never counts a place on a cancelled shift, a cancelled event or a cancelled sign-up", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const seeded = await seedSeason({ name: "Fall", steps: [{ name: "Volunteer" }] });
    const [r] = await db.insert(requirement).values({ stepId: Object.values(seeded.stepIds)[0]!, kind: "volunteer", title: "Family shifts", appliesTo: "family", amount: 3, amountUnit: "shifts", position: 0 }).returning();
    const on = await seedEvent({ shifts: [{ requirementIds: [r!.id] }, { requirementIds: [r!.id], cancelled: true }] });
    const off = await seedEvent({ cancelled: true, shifts: [{ requirementIds: [r!.id] }] });
    for (const shift of [...on.shifts, ...off.shifts]) await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: "x" });
    await seedSignup({ shiftId: on.shifts[0]!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO!, cancelled: true });
    const season = (await loadMySeason(ctxOf(a.identity)))!;
    expect(season.steps[0]!.family.map((l) => l.words)).toEqual(["0 of 3 shifts done, signed up for 1"]);
  });

  it("refuses a full shift, one that has started, and the same person twice", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [full, open] } = await seedEvent({ shifts: [{ places: 1 }, { places: 5 }] });
    await seedSignup({ shiftId: full!.id, familyQboId: "SOMEONE-ELSE", signedUpBy: NO_SUCH, guardianName: "Someone" });
    asParent(a.identity);
    expect(await signUpAction(full!.id, "me")).toEqual({ ok: false, errors: ["Sorry, that shift is full now. Every place has been taken."] });
    expect(await signUpAction(open!.id, await studentChoice(AZALEA!))).toMatchObject({ ok: true });
    expect(await signUpAction(open!.id, await studentChoice(AZALEA!))).toEqual({ ok: false, errors: [`${AZALEA!.name} is signed up for this shift already.`] });
    expect(await signUpAction(open!.id, "me")).toMatchObject({ ok: true });
    expect(await signUpAction(open!.id, "me")).toEqual({ ok: false, errors: ["You're signed up for this shift already."] });
    const today = await seedEvent({ onDate: MARCH_10, shifts: [{ startsAt: "10:00", endsAt: "12:00" }] });
    const at = new Date("2027-03-10T10:00:00Z");
    expect(await signUpForShift(ctxOf(a.identity), today.shifts[0]!.id, "me", new Date(at.getTime() - 1000))).toMatchObject({ ok: true });
    expect(await signUpForShift(ctxOf(a.identity), today.shifts[0]!.id, await studentChoice(AURELIO!), at)).toEqual({ ok: false, errors: ["That shift has started, so it's too late to sign up for it."] });
    expect((await live()).length).toBe(4);
  });

  it("refuses one person two places at the same time, at one event or two, and allows back-to-back shifts", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [stand1, stand2, later] } = await seedEvent({ shifts: [{ startsAt: "18:00", endsAt: "21:00" }, { startsAt: "18:00", endsAt: "21:00" }, { startsAt: "21:00", endsAt: "22:00" }] });
    const elsewhere = await seedEvent({ name: "Bake sale", shifts: [{ startsAt: "20:00", endsAt: "23:00" }] });
    asParent(a.identity);
    const [aurelio, azalea] = [await studentChoice(AURELIO!), await studentChoice(AZALEA!)];
    expect(await signUpAction(stand1!.id, aurelio)).toMatchObject({ ok: true });
    expect(await signUpAction(stand2!.id, aurelio)).toEqual({ ok: false, errors: [`${AURELIO!.name} is signed up for another shift at that time.`] });
    expect(await signUpAction(elsewhere.shifts[0]!.id, aurelio)).toEqual({ ok: false, errors: [`${AURELIO!.name} is signed up for another shift at that time.`] });
    expect(await signUpAction(later!.id, aurelio)).toMatchObject({ ok: true }); // starts as the first ends
    expect(await signUpAction(stand2!.id, azalea)).toMatchObject({ ok: true }); // someone else may
    expect(await signUpAction(stand1!.id, "me")).toMatchObject({ ok: true });
    expect(await signUpAction(stand2!.id, "me")).toEqual({ ok: false, errors: ["You're signed up for another shift at that time."] });
    expect((await live()).length).toBe(4);
  });

  it("refuses a shift that isn't offered, and anything a page never sends", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [cancelledShift] } = await seedEvent({ shifts: [{ cancelled: true }] });
    const { shifts: [ofCancelledEvent] } = await seedEvent({ cancelled: true });
    const { shifts: [open] } = await seedEvent();
    asParent(a.identity);
    for (const shiftId of [NO_SUCH, cancelledShift!.id, ofCancelledEvent!.id]) expect(await signUpAction(shiftId, "me")).toEqual(NOT_OFFERED);
    // A student by QuickBooks id is not what a page sends either: it sends the app's id.
    for (const [shiftId, who] of [["not-a-uuid", "me"], [open!.id, ""], [open!.id, { qboId: AURELIO!.qboId }], [open!.id, AURELIO!.qboId], [open!.id, "x".repeat(65)], [open!.id, null], [123, "me"]] as const) {
      expect(await signUpAction(shiftId as never, who as never)).toEqual(NOT_FROM_PAGE);
    }
    for (const id of [NO_SUCH, cancelledShift!.id, ofCancelledEvent!.id, "nope"]) expect(await loadShiftForMe(ctxOf(a.identity), id)).toBeNull();
    expect(await signups()).toEqual([]);
  });

  it("signs up only the family's own active students: family B's student, an inactive one or the family itself are refused", async () => {
    const { a, b } = await seedTwoFamilies();
    await addToCache([stu("QBO-ALDERQUIST-STUDENT-7999", "Gone Alderquist (deleted)", FAMILY_A.family.qboId, { active: false })]);
    const { shifts: [shift] } = await seedEvent({ name: "Bake sale" });
    asParent(a.identity);
    // Family B's own records, by the app's ids as a page would send them, an inactive student of A's, A's family as a
    // student, and the same by QuickBooks id: none fills a place for A.
    const appIds = [String(await studentId(BARNABY!.qboId)), String(await familyId(FAMILY_B.family.qboId)), String(await studentId("QBO-ALDERQUIST-STUDENT-7999")),
      String(await familyId(FAMILY_A.family.qboId))];
    for (const who of [...appIds, BARNABY!.qboId, FAMILY_B.parent.qboId, FAMILY_B.family.qboId, "QBO-ALDERQUIST-STUDENT-7999", FAMILY_A.family.qboId, FAMILY_A.parent.qboId, b.identity.parentId]) {
      expect(await signUpAction(shift!.id, who), who).toEqual(NOT_FROM_PAGE);
    }
    expect((await signups()).filter((s) => s.shiftId === shift!.id)).toEqual([]);
    // A student of A's who has moved to family B since the page was drawn is refused too: the family's students are the
    // app's own records, and hers follows her (as the roster read that finds the move leaves it). B's page may now send her.
    const azalea = await studentChoice(AZALEA!);
    await moveInCache([AZALEA!.qboId], FAMILY_B.family.qboId);
    expect(await signUpForShift(ctxOf(a.identity), shift!.id, azalea)).toEqual(NOT_FROM_PAGE);
    expect(await signUpAction(shift!.id, azalea)).toEqual(NOT_FROM_PAGE);
    expect((await signups()).filter((s) => s.shiftId === shift!.id)).toEqual([]);
  });

  it("leaves exactly as many people signed up as there are places when they all take them at the same moment", async () => {
    const a = await seedSignedInParent(FAMILY_A), b = await seedSignedInParent(FAMILY_B);
    let shiftId = "";
    const [kidsA, kidsB] = [await Promise.all(FAMILY_A.students.map(studentChoice)), await Promise.all(FAMILY_B.students.map(studentChoice))];
    const people = [
      () => signUpForShift(ctxOf(a.identity), shiftId, "me"), () => signUpForShift(ctxOf(b.identity), shiftId, "me"),
      ...kidsA.map((s) => () => signUpForShift(ctxOf(a.identity), shiftId, s)),
      ...kidsB.map((s) => () => signUpForShift(ctxOf(b.identity), shiftId, s)),
    ];
    for (const [round, places] of [1, 1, 1, 2, 3].entries()) {
      // Each round on its own day: one person can't hold two places at the same time.
      shiftId = (await seedShift((await seedEvent({ inDays: 30 + round, shifts: [] })).event.id, { places })).id;
      // Six people from two families, each on their own connection, all at once.
      const results = await Promise.all(people.map((go) => go()));
      expect(results.filter((r) => r.ok)).toHaveLength(places);
      expect(results.filter((r) => !r.ok).map((r) => (r as { errors: string[] }).errors)).toEqual(Array(6 - places).fill(["Sorry, that shift is full now. Every place has been taken."]));
      expect(await db.select().from(volunteerSignup).where(and(eq(volunteerSignup.shiftId, shiftId), isNull(volunteerSignup.cancelledAt)))).toHaveLength(places);
    }
  });
});

describe("the rate limit on signing up", () => {
  it("refuses a guardian's 31st sign-up press in 15 minutes, takes no place, and audits the first refusal once", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [shift] } = await seedEvent({ name: "Fish fry", shifts: [{ places: 3 }] });
    const ctx = ctxOf(a.identity);
    for (let i = 0; i < 30; i++) expect(await signUpForShift(ctx, NO_SUCH, "me")).toEqual(NOT_OFFERED);
    const limited = { ok: false, errors: ["That's a lot of sign-ups in a few minutes. Please wait a little, then try again."] };
    expect(await signUpForShift(ctx, shift!.id, "me")).toEqual(limited);
    expect(await signUpForShift(ctx, shift!.id, "me")).toEqual(limited);
    expect(await signups()).toEqual([]);
    expect(await audits("volunteer.signup.refused")).toMatchObject([{ targetId: a.identity.parentId, after: { code: "rate_limited" }, ip: "203.0.113.50" }]);
    // Another guardian has a count of their own.
    const b = await seedSignedInParent(FAMILY_B);
    expect((await signUpForShift(ctxOf(b.identity), shift!.id, "me")).ok).toBe(true);
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
    expect(await cancelMySignup(ctxOf(a.identity), mine.id, cutoff)).toEqual({ ok: false,
      errors: ["It's too close to the shift to cancel here: the portal takes cancellations until 48 hours before it starts. Please contact Pat Organizer (pat@club.example)."] });
    expect((await live()).map((s) => s.id)).toContain(mine.id);
    expect(await cancelMySignup(ctxOf(a.identity), mine.id, new Date(cutoff.getTime() - 1000))).toEqual({ ok: true,
      message: `Cancelled. ${AURELIO!.name}'s place is free for someone else now. Thanks for letting us know. If you added it to your calendar, you can delete it there.` });
    const [row] = await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, mine.id));
    expect(row).toMatchObject({ cancelledByDoor: "parent", cancelledBy: a.identity.parentId });
    expect((await audits("volunteer.signup.cancel"))[0]).toMatchObject({ door: "parent", actorId: a.identity.parentId, targetId: mine.id, after: { cancelled: true } });
    expect(await cancelMySignup(ctxOf(a.identity), mine.id, new Date(cutoff.getTime() - 1000))).toEqual({ ok: false, errors: ["That sign-up isn't there any more. Reload the page."] });
  });

  it("moves the cut-off with the club's setting and its time zone", async () => {
    const { a, mine } = await seedOwn();
    await setZone("America/Chicago"); // 18:00 CST on March 10 is 00:00 UTC on March 11
    await db.insert(setting).values({ key: VOLUNTEER_SETTINGS_KEY, value: { cutoffHours: 2 } });
    const v = await loadMyVolunteering(ctxOf(a.identity), new Date("2027-03-10T21:59:59Z"));
    expect(v.signups.map((s) => [s.cancel, s.cancelUntil])).toEqual([["open", "Wednesday, March 10, 4:00 pm"]]);
    expect(await cancelMySignup(ctxOf(a.identity), mine.id, new Date("2027-03-10T22:00:00Z"))).toMatchObject({ ok: false });
    expect((await loadMyVolunteering(ctxOf(a.identity), new Date("2027-03-10T22:00:00Z"))).signups.map((s) => s.cancel)).toEqual(["closed"]);
    expect(await cancelMySignup(ctxOf(a.identity), mine.id, new Date("2027-03-10T21:59:59Z"))).toMatchObject({ ok: true });
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

  it("once the shift has started, the page says to check in there, not that it is too close to cancel", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const at = shiftAround(new Date(), 30, 90);
    const shift = await seedEvent({ onDate: at.onDate, contactName: "Robin Lead", contactEmail: null, shifts: [{ startsAt: at.startsAt, endsAt: at.endsAt }] });
    await seedSignup({ shiftId: shift.shifts[0]!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    asParent(a.identity);
    const page = textOf(await renderPage(VolunteerPage));
    expect(page).toContain("This shift has started. To check in, scan the club's check-in code at the shift. If you can't make it, please contact Robin Lead.");
    expect(page).not.toContain("before the shift, so it can't be cancelled");
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

  it("a student moved to another family takes their sign-up along: the old family no longer sees it or can cancel it", async () => {
    const { a, mine } = await seedOwn();
    const early = new Date("2027-03-01T12:00:00Z");
    expect((await loadMyVolunteering(ctxOf(a.identity), early)).signups.map((s) => s.id)).toEqual([mine.id]);
    await moveInCache([AURELIO!.qboId], FAMILY_B.family.qboId); // as a move staff make leaves it: the app's records follow
    const view = await loadMyVolunteering(ctxOf(a.identity), early);
    expect(view.signups).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(AURELIO!.name);
    expect(await cancelMySignup(ctxOf(a.identity), mine.id, early)).toEqual({ ok: false, errors: ["That sign-up isn't there any more. Reload the page."] });
    expect((await live()).map((s) => s.id)).toContain(mine.id);
    // The same for a student made inactive.
    await db.update(qboCustomer).set({ parentQboId: FAMILY_A.family.qboId, active: false }).where(eq(qboCustomer.qboId, AURELIO!.qboId));
    await syncAppRecords(); // as the roster read that saw it does
    expect((await loadMyVolunteering(ctxOf(a.identity), early)).signups).toEqual([]);
  });

  it("says when the club has cancelled the shift, and has nothing to cancel", async () => {
    const { a } = await seedOwn();
    const later = await seedEvent({ inDays: 10, shifts: [{ cancelled: true }] });
    const s = await seedSignup({ shiftId: later.shifts[0]!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    expect(await cancelMySignup(ctxOf(a.identity), s.id)).toEqual({ ok: false, errors: ["The club has cancelled this shift, so there's nothing to cancel."] });
    const v = await loadMyVolunteering(ctxOf(a.identity));
    expect(v.signups.find((x) => x.id === s.id)?.cancel).toBe("cancelled");
    expect(v.events.flatMap((e) => e.shifts.map((x) => x.id))).not.toContain(later.shifts[0]!.id);
  });
});

describe("a session whose family record is inactive", () => {
  it("refuses on every parent path, shows none of the family's places or credit, and writes nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const seeded = await seedSeason({ name: "Fall", steps: [{ name: "Volunteer" }] });
    const [hours] = await db.insert(requirement).values({ stepId: Object.values(seeded.stepIds)[0]!, kind: "volunteer", title: "Family hours", appliesTo: "family", amount: 6, amountUnit: "hours", position: 0 }).returning();
    const t = shiftAround(new Date(), 10, 120);
    const { shifts: [now] } = await seedEvent({ name: "Under way", onDate: t.onDate, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt }] });
    const { shifts: [later] } = await seedEvent({ name: "Later on", inDays: 10, shifts: [{}] });
    const here = await seedSignup({ shiftId: now!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    const mine = await seedSignup({ shiftId: later!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO! });
    await seedOutsideCredit({ familyQboId: FAMILY_A.family.qboId, requirementId: hours!.id, minutes: 60 });
    const ctx = ctxOf(a.identity);
    // A family's record made inactive (as a staff write makes one), while the session still names it.
    await db.update(familyTable).set({ active: false }).where(eq(familyTable.id, await familyId(FAMILY_A.family.qboId)));
    const snapshot = async () => JSON.stringify([await db.select().from(volunteerSignup).orderBy(asc(volunteerSignup.id)), await db.select().from(volunteerCredit).orderBy(asc(volunteerCredit.id))]);
    const before = await snapshot();

    const v = await loadMyVolunteering(ctx);
    expect(v.events.map((e) => e.name)).toEqual(expect.arrayContaining(["Under way", "Later on"]));
    expect(v.signups).toEqual([]);
    expect(await loadShiftForMe(ctx, later!.id)).toBeNull();
    asParent(a.identity);
    // The page says only that the family isn't set up yet, as every parent page does for a family it may not show.
    expect(await renderPage(ShiftPage, { params: { id: later!.id } })).toContain("set up here yet");
    expect(await signUpForShift(ctx, later!.id, "me")).toEqual({ ok: false, errors: ["Your family isn't set up in the portal yet, so you can't sign up here. Please ask the club."] });
    expect(await cancelMySignup(ctx, mine.id)).toEqual({ ok: false, errors: ["That sign-up isn't there any more. Reload the page."] });
    expect((await loadCheckInForMe(ctx, now!.checkinCode))!.people).toEqual([]);
    expect(await checkIn(ctx, now!.checkinCode, here.id)).toEqual(NOT_FROM_PAGE);
    expect(await checkIn(ctx, now!.checkinCode, "all")).toEqual({ ok: false, errors: ["Nobody in your family is signed up for this shift, so there's no one to check in."] });
    expect(await loadMyCredit(ctx)).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(mail.outbox).toEqual([]);
  });
});

describe("a family with no link to QuickBooks", () => {
  it("still sees its places and its credit, and signs its own students up: volunteering reads the family's own records", async () => {
    const { a, b } = await seedTwoFamilies();
    const before = await loadMyVolunteering(ctxOf(a.identity));
    const credit = await loadMyCredit(ctxOf(a.identity));
    expect(before.signups.length).toBeGreaterThan(0);
    // The family's link and its students' links are gone (from stage 3 a family may have none).
    const students = await Promise.all(FAMILY_A.students.map((s) => studentId(s.qboId)));
    await db.delete(accountingLink).where(or(eq(accountingLink.familyId, a.identity.familyId), inArray(accountingLink.studentId, students)));
    expect(await loadMyVolunteering(ctxOf(a.identity))).toEqual(before);
    expect(await loadMyCredit(ctxOf(a.identity))).toEqual(credit);
    const { shifts: [shift] } = await seedEvent({ inDays: 41, shifts: [{ places: 3 }] });
    const view = (await loadShiftForMe(ctxOf(a.identity), shift!.id))!;
    expect(view.choices.map((c) => c.label)).toEqual([`Me (${FAMILY_A.parent.name})`, AURELIO!.name, AZALEA!.name]);
    expect((await signUpForShift(ctxOf(a.identity), shift!.id, String(students[0]))).ok).toBe(true);
    expect(await live()).toEqual(expect.arrayContaining([expect.objectContaining({ shiftId: shift!.id, familyId: a.identity.familyId, studentId: students[0] })]));
    for (const marker of b.markers) expect(JSON.stringify(view)).not.toContain(marker);
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
    expect(await signUpForShift(ctxOf(a.identity), shift!.id, "me", now)).toEqual({ ok: false, errors: ["That shift has started, so it's too late to sign up for it."] });
    await setZone("Pacific/Pago_Pago"); // UTC-11: it runs 21:00 to 22:00 UTC on March 10
    expect((await loadMyVolunteering(ctxOf(a.identity), now)).events.flatMap((e) => e.shifts.map((s) => s.state))).toEqual(["open"]);
    expect(await signUpForShift(ctxOf(a.identity), shift!.id, "me", now)).toMatchObject({ ok: true });
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
    expect(audit!.after).toEqual({ reason: "different_company", realmId: "9130000000000002", signups: 2, cancelledSignups: 1, credits: 2, removedCredits: 0, reminders: 0, buyouts: 2 });
  });
});

describe("the order shifts are listed in", () => {
  it("is decided for shifts that start together and were made together, as an event's copy makes them", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { event } = await seedEvent({ inDays: 5, shifts: [] });
    // One statement, so both have the same time made; the later id is written first, so the order the rows happen to
    // come back in is not the order by id.
    const [early, late] = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"];
    await db.insert(volunteerShift).values([late, early].map((id, i) => ({ id, eventId: event.id, startsAt: "18:00", endsAt: "21:00", places: 4, role: i === 0 ? "Gate" : "Tickets" })));
    const listed = (await loadMyVolunteering(ctxOf(a.identity))).events.find((e) => e.id === event.id)!;
    expect(listed.shifts.map((s) => s.id)).toEqual([early, late]);
  });
});
