import { describe, it, expect, beforeEach, vi } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage, revalidatedPaths, signedOut } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string; attachments?: { filename: string; contentType: string; content: string }[] };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, requirement, role, roleAssignment, roleRule, volunteerCredit, volunteerReminder, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { env } from "@/env";
import { AccessDenied } from "@/lib/guards";
import { ADMIN_ONLY, GRANTABLE } from "@/lib/permissions/registry";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { currentRosterTag, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { volunteerForMovedStudent } from "@/lib/volunteer/moved-student";
import VolunteerEventPage from "@/app/staff/(app)/volunteer/[id]/page";
import CheckInSheetPage from "@/app/staff/(app)/volunteer/check-in/[shiftId]/page";
import CreditPage from "@/app/staff/(app)/volunteer/credit/page";
import FamilyCreditPage from "@/app/staff/(app)/volunteer/credit/[familyId]/page";
import CheckInPage from "@/app/(parent)/volunteer/check-in/[code]/page";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import { cancelShiftAction, removeSignupAction, renewCheckInCodeAction, updateShiftAction } from "@/app/staff/(app)/volunteer/actions";
import { addCheckInAction, addOutsideCreditAction, removeCreditAction } from "@/app/staff/(app)/volunteer/credit/actions";
import { resetDb, seedStaff, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { TWO_FAMILY_HOURS, seedCheckIn, seedEvent, seedSignup, shiftAround } from "../helpers/volunteer";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * The staff side of check-in and credit (v1 spec §11.4): each shift's check-in sheet, a missed check-in added or one
 * removed, one person's sign-up removed, a family's credit and volunteering done outside the portal. For every page
 * and action: the guard and its permission, each id checked under the roster lock, and the audit row with before and
 * after. Notes and reasons are for staff: a parent reads "Added by the club" and nothing more. Sign-ups and credit name
 * the app's own families and students (stage 2 of the app-owned families spec), and so do the pages' forms and new
 * audit rows; a family's page keeps its address by QuickBooks id.
 */
type Staff = Awaited<ReturnType<typeof seedStaff>>;
const BROWSER = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const NO_SUCH = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
// The label a table's cell carries on a phone repeats its column's header: left out, so a row reads as its cells.
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<span class="t-label"[^>]*>[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const audits = async (action?: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => !action || r.action === action);
const credits = () => db.select().from(volunteerCredit).orderBy(asc(volunteerCredit.createdAt));
const live = async () => (await credits()).filter((c) => c.removedAt === null);
const [AURELIO] = FAMILY_A.students;
/** The app's own records of the fixtures, as sign-ups, credit and the pages' forms name them. */
const familyOf = (qboId: string) => recordOfCustomer(qboId, "family");
const studentOf = (qboId: string) => recordOfCustomer(qboId, "student");
const idOf = async (record: Promise<unknown>) => String(await record);

const withRole = async (email: string, name: string, patterns: string[]): Promise<Staff> => {
  const s = await seedStaff({ email, name });
  const [r] = await db.insert(role).values({ key: email, name }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};

let writer: Staff, eventsOnly: Staff, creditOnly: Staff, reader: Staff;
vi.setConfig({ testTimeout: 30_000 });
beforeEach(async () => {
  await resetDb(); mail.outbox.length = 0;
  await seedWorkingMail();
  writer = await withRole("writer@club.org", "Wren Writer", ["Volunteer.*"]);
  eventsOnly = await withRole("events@club.org", "Eve Events", ["Volunteer.Event.ReadWrite", "Volunteer.Event.Read"]);
  creditOnly = await withRole("credit@club.org", "Cal Credit", ["Volunteer.Event.Read", "Volunteer.Credit.ReadWrite"]);
  reader = await withRole("reader@club.org", "Rae Reader", ["Volunteer.Event.Read"]);
  asStaff(writer);
});

/** The two families of seedTwoFamilies(): A's student checked in on the shared shift, B signed up, with two hours done outside the portal. */
const shared = async () => {
  const { a, b } = await seedTwoFamilies();
  const [shift] = await db.select().from(volunteerShift).where(eq(volunteerShift.id, a.volunteer!.shiftId));
  const signups = await db.select().from(volunteerSignup).where(eq(volunteerSignup.shiftId, shift!.id));
  const [famA, famB] = [await idOf(familyOf(FAMILY_A.family.qboId)), await idOf(familyOf(FAMILY_B.family.qboId))];
  const forA = signups.find((s) => String(s.familyId) === famA)!, forB = signups.find((s) => String(s.familyId) === famB)!;
  const [hours] = await db.select().from(requirement).where(eq(requirement.title, TWO_FAMILY_HOURS));
  return { a, b, shift: shift!, eventId: shift!.eventId, forA, forB, famA, famB, hours: hours!, tag: await currentRosterTag() };
};
/** A shift of a new event that started 10 minutes ago, with A's parent signed up. */
const startedShift = async (a: SeededParent, requirementIds: string[] = []) => {
  const t = shiftAround(new Date(), 10, 120);
  const { event, shifts: [shift] } = await seedEvent({ name: "Tonight's concessions", onDate: t.onDate, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt, requirementIds }] });
  const signup = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
  return { event, shift: shift!, signup };
};

describe("the credit permission, pages and actions", () => {
  it("is an ordinary permission a custom role can hold", () => {
    expect(GRANTABLE).toContain("Volunteer.Credit.ReadWrite");
    expect(ADMIN_ONLY).not.toContain("Volunteer.Credit.ReadWrite");
  });

  it("refuses each page and action to staff without its permission, and to a parent, and changes nothing", async () => {
    const { a, shift, forB, famA, hours, tag } = await shared();
    const [credit] = await live();
    const creditActions = [() => addCheckInAction(forB.id, tag), () => removeCreditAction(credit!.id, tag, "Mistake"),
      () => addOutsideCreditAction(tag, famA, { requirementId: hours.id, who: "family", amount: "1", note: "Raked leaves" })];
    const eventActions = [() => renewCheckInCodeAction(shift.id), () => removeSignupAction(forB.id)];
    const creditPages = [() => pageOutcome(CreditPage), () => pageOutcome(FamilyCreditPage, { params: { familyId: famA } })];
    const sheet = () => pageOutcome(CheckInSheetPage, { params: { shiftId: shift.id } });
    const snapshot = async () => JSON.stringify([await credits(), await db.select().from(volunteerShift), await db.select().from(volunteerSignup).orderBy(asc(volunteerSignup.id))]);
    const before = await snapshot();
    for (const who of [reader, eventsOnly]) {
      asStaff(who);
      for (const act of creditActions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
      for (const page of creditPages) expect(await page()).toEqual({ redirect: "/refused" });
    }
    for (const who of [reader, creditOnly]) {
      asStaff(who);
      for (const act of eventActions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
      expect(await sheet()).toEqual({ redirect: "/refused" });
    }
    signedOut();
    asParent(a.identity);
    for (const act of [...creditActions, ...eventActions]) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    for (const page of [...creditPages, sheet]) expect(await page()).toEqual({ redirect: "/staff/sign-in" });
    expect(await snapshot()).toBe(before);
    expect(revalidatedPaths()).toEqual([]);
    expect((await audits()).filter((r) => r.action.startsWith("volunteer.")).map((r) => r.action)).toEqual([]);
  });

  it("refuses anything a page could not send", async () => {
    const { forB, famA, hours, tag } = await shared();
    for (const r of [await addCheckInAction("nope", tag), await addCheckInAction(forB.id, "bad tag!"), await removeCreditAction("nope", tag, "x"), await removeCreditAction(NO_SUCH, tag, 7 as never),
      await addOutsideCreditAction(tag, famA, null as never), await addOutsideCreditAction(tag, 12 as never, { requirementId: hours.id, who: "family", amount: "1", note: "n" }),
      await addOutsideCreditAction(tag, famA, { requirementId: "nope", who: "family", amount: "1", note: "n" }),
      // A family or student by QuickBooks id is not what the page sends: it sends the app's own ids.
      await addOutsideCreditAction(tag, FAMILY_A.family.qboId, { requirementId: hours.id, who: "family", amount: "1", note: "n" }),
      await addOutsideCreditAction(tag, famA, { requirementId: hours.id, who: AURELIO!.qboId, amount: "1", note: "n" }),
      await renewCheckInCodeAction("nope"), await removeSignupAction("nope")]) expect(r).toEqual(BROWSER);
  });
});

describe("a shift's check-in sheet", () => {
  it("draws the code as a QR code on the server, writes out the address it opens, and makes a new code that stops the old one", async () => {
    const { a, shift, forA } = await shared();
    const html = await renderPage(CheckInSheetPage, { params: { shiftId: shift.id } });
    const address = `${env.APP_URL.replace(/\/+$/, "")}/volunteer/check-in/${shift.checkinCode}`;
    expect(textOf(html)).toContain(`Or open: ${address}`);
    // The address is long and random, so the sheet also says what to do when a phone can't scan.
    expect(textOf(html)).toContain("If your phone can't scan the code, tell the person running the shift: they can record your check-in for you.");
    expect(textOf(html)).toContain("Marching band car wash");
    expect(textOf(html)).toContain("9:00 am to noon");
    expect(html).toMatch(/<svg class="checkin-qr"[^>]*viewBox="0 0 \d+ \d+"[^>]*>/);
    // Black on white in every theme: a forced-colors theme changes currentColor (white in a dark one) but not a fill.
    expect(html).toMatch(/<rect [^>]*fill="white"/);
    expect(html).toMatch(/<path d="(M\d+ \d+h1v1h-1z)+" fill="black"/);
    // Nothing but the drawing: no script, no image file, no HTML string built from text.
    const source = readFileSync(path.resolve(__dirname, "../../src/app/staff/(app)/volunteer/qr-code.tsx"), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|<script|<img/);
    expect(shift.checkinCode).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(shift.checkinCode).not.toContain(shift.id.replaceAll("-", ""));
    for (const shiftId of [NO_SUCH, "nope"]) expect(await pageOutcome(CheckInSheetPage, { params: { shiftId } })).toEqual({ notFound: true });

    expect(await renewCheckInCodeAction(shift.id)).toMatchObject({ ok: true });
    const [renewed] = await db.select().from(volunteerShift).where(eq(volunteerShift.id, shift.id));
    expect(renewed!.checkinCode).not.toBe(shift.checkinCode);
    expect(renewed!.checkinCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [audit] = await audits("volunteer.shift.code.renew");
    expect(JSON.stringify(audit)).not.toContain(shift.checkinCode);
    expect(JSON.stringify(audit)).not.toContain(renewed!.checkinCode);
    // The printed code opens nothing now; the new one opens the shift; the check-in already made stays.
    asParent(a.identity);
    expect(await pageOutcome(CheckInPage, { params: { code: shift.checkinCode } })).toEqual({ notFound: true });
    expect(textOf(await renderPage(CheckInPage, { params: { code: renewed!.checkinCode } }))).toContain(`${AURELIO!.name} Checked in`);
    expect((await live()).some((c) => c.signupId === forA.id)).toBe(true);
  });
});

describe("check-ins on a shift's sign-up list", () => {
  it("shows who is checked in, adds a missed check-in once the shift has started, and refuses one before", async () => {
    const { a, eventId, forB, tag } = await shared();
    const before = textOf(await renderPage(VolunteerEventPage, { params: { id: eventId } }));
    expect(before).toMatch(new RegExp(`${AURELIO!.name} .* Checked in`));
    expect(before).toContain("Check-in code to print");
    // The shared shift is still to come.
    expect(await addCheckInAction(forB.id, tag)).toEqual({ ok: false, errors: ["This shift hasn't started yet. A missed check-in can be added once it has."] });
    const { event, signup } = await startedShift(a);
    expect(textOf(await renderPage(VolunteerEventPage, { params: { id: event.id } }))).toContain(`Check in ${FAMILY_A.parent.name}`);
    expect(await addCheckInAction(signup.id, tag)).toEqual({ ok: true, message: "Checked in. It counts as if they had checked in themselves." });
    expect(await addCheckInAction(signup.id, tag)).toEqual({ ok: false, errors: ["This person is checked in already."] });
    const made = (await live()).find((c) => c.signupId === signup.id)!;
    expect(made).toMatchObject({ kind: "staff_checkin", familyId: await familyOf(FAMILY_A.family.qboId), minutes: 130, shifts: 1, createdByDoor: "staff", createdBy: writer.id });
    expect((await audits("volunteer.checkin.add"))[0]).toMatchObject({ permission: "Volunteer.Credit.ReadWrite", targetId: made.id, before: { checkedIn: false },
      after: { signupId: signup.id, familyId: await idOf(familyOf(FAMILY_A.family.qboId)), event: "Tonight's concessions" } });
    expect(textOf(await renderPage(VolunteerEventPage, { params: { id: event.id } }))).toContain("Checked in (added by Wren Writer)");
    // The family reads it as a check-in like any other.
    asParent(a.identity);
    expect(textOf(await renderPage(VolunteerPage))).toMatch(/Tonight's concessions.*Checked in/);
  });

  it("removes a check-in with a reason only staff see, and the family's credit goes with it", async () => {
    const { a, forA, tag } = await shared();
    const credit = (await live()).find((c) => c.signupId === forA.id)!;
    expect(await removeCreditAction(credit.id, tag, "   ")).toEqual({ ok: false, errors: ["Say why it's being removed. Only staff see the reason."] });
    expect(await removeCreditAction(credit.id, tag, "x".repeat(501))).toEqual({ ok: false, errors: ["The reason is too long (500 characters at most)."] });
    const reason = "Left before the shift began QA99";
    expect(await removeCreditAction(credit.id, tag, ` ${reason} `)).toEqual({ ok: true, message: "Removed. It no longer counts toward anything." });
    expect(await removeCreditAction(credit.id, tag, reason)).toEqual({ ok: false, errors: ["That isn't there any more. Reload the page."] });
    const [row] = await db.select().from(volunteerCredit).where(eq(volunteerCredit.id, credit.id));
    expect(row).toMatchObject({ removedBy: writer.id, removedReason: reason });
    expect((await audits("volunteer.credit.remove"))[0]).toMatchObject({ before: { kind: "checkin", signupId: forA.id, minutes: 180, removed: false }, after: { removed: true, reason } });
    // A sign-up whose check-in is removed counts as signed up again, and the reason reaches no parent page.
    asParent(a.identity);
    const page = textOf(await renderPage(VolunteerPage));
    expect(page).toContain("0 of 6 hours done, signed up for 3");
    expect(page).not.toContain("Done so far");
    expect(page).not.toContain(reason);
    // Staff see it among the removed credit, with the reason.
    asStaff(writer);
    const staffPage = textOf(await renderPage(FamilyCreditPage, { params: { familyId: String(await familyOf(FAMILY_A.family.qboId)) } }));
    expect(staffPage).toContain("Removed credit");
    expect(staffPage).toContain(`Reason (staff only): ${reason}`);
  });

  it("refuses a correction from a page that was shown another company's roster", async () => {
    const { a, forA, famA } = await shared();
    const { signup } = await startedShift(a);
    await db.transaction((tx) => setRosterSource(tx, "1111"));
    const shown = await currentRosterTag();
    await db.transaction((tx) => setRosterSource(tx, "2222"));
    const credit = (await live()).find((c) => c.signupId === forA.id)!;
    const before = JSON.stringify(await credits());
    for (const r of [await addCheckInAction(signup.id, shown), await removeCreditAction(credit.id, shown, "Mistake"),
      await addOutsideCreditAction(shown, famA, { requirementId: (await db.select().from(requirement).where(eq(requirement.title, TWO_FAMILY_HOURS)))[0]!.id, who: "family", amount: "1", note: "Raked leaves" })]) {
      expect(r).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    }
    expect(JSON.stringify(await credits())).toBe(before);
  });
});

describe("removing one person's sign-up", () => {
  it("is refused while it is checked in, and otherwise frees the place and tells the guardian who took it", async () => {
    const { b, eventId, forA, forB } = await shared();
    expect(await removeSignupAction(forA.id)).toEqual({ ok: false, errors: [`${AURELIO!.name} is checked in for this shift. Remove the check-in first, then the sign-up.`] });
    expect(mail.outbox).toEqual([]);
    expect(await removeSignupAction(forB.id)).toEqual({ ok: true, message: "Removed. The place is free again. The guardian who signed up has been emailed." });
    expect(await removeSignupAction(forB.id)).toEqual({ ok: false, errors: ["That isn't there any more. Reload the page."] });
    const [row] = await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, forB.id));
    expect(row).toMatchObject({ cancelledByDoor: "staff", cancelledBy: writer.id });
    expect(row!.cancelledAt).not.toBeNull();
    expect((await audits("volunteer.signup.remove"))[0]).toMatchObject({ permission: "Volunteer.Event.ReadWrite", targetId: forB.id,
      before: { familyId: await idOf(familyOf(FAMILY_B.family.qboId)), fillerName: FAMILY_B.parent.name, removed: false }, after: { removed: true, guardianTold: true } });
    expect(mail.outbox.map((m) => [m.to, m.subject])).toEqual([[FAMILY_B.parent.email, "Your place has been freed: Marching band car wash"]]);
    const [m] = mail.outbox;
    expect(m!.text).toContain("The club has taken your place off a shift at Marching band car wash (Rinse crew), so you don't need to come.");
    expect(m!.attachments?.[0]?.content).toContain("METHOD:CANCEL");
    expect(m!.text).not.toContain(FAMILY_A.family.name);
    expect(m!.text).not.toContain(AURELIO!.name);
    expect(textOf(await renderPage(VolunteerEventPage, { params: { id: eventId } }))).toContain("1 of 4 places filled");
    asParent(b.identity);
    expect(textOf(await renderPage(VolunteerPage))).not.toContain("You're doing this one");
  });
});

describe("a family's credit page", () => {
  it("is audited before it shows anything, shows each credit with its note and where it is spent, and answers 404 for a family the roster doesn't show", async () => {
    const { b, famB } = await shared();
    // Text, its QuickBooks id (the old address), a uuid that names nothing, a student's record: none is a family record.
    for (const familyId of ["no-such-family", "x".repeat(65), FAMILY_B.family.qboId, crypto.randomUUID(), String(await studentOf(FAMILY_B.students[0]!.qboId))]) {
      expect(await pageOutcome(FamilyCreditPage, { params: { familyId } }), familyId).toEqual({ notFound: true });
    }
    expect(await audits("volunteer.credit.family.read")).toEqual([]);
    const page = textOf(await renderPage(FamilyCreditPage, { params: { familyId: famB } }));
    // The page's address and its audit row name the app's own family.
    expect(await audits("volunteer.credit.family.read")).toMatchObject([{ actorId: writer.id, permission: "Volunteer.Credit.ReadWrite", targetType: "family", targetId: famB }]);
    expect(page).toContain(FAMILY_B.family.name);
    expect(page).toContain(`Done outside the portal: ${TWO_FAMILY_HOURS}`);
    expect(page).toContain(`Note (staff only): ${b.volunteer!.staffOnly[0]}`);
    expect(page).toContain(`Counts as 2 hours toward ${TWO_FAMILY_HOURS}.`);
    expect(page).toContain("2 of 6 hours done, signed up for 3");
    expect(page).not.toContain(FAMILY_A.family.name);
    const listed = await renderPage(CreditPage), list = textOf(listed);
    // Each family links to its own page by its app record, never by its customer.
    expect(listed).toContain(`href="/staff/volunteer/credit/${famB}"`);
    expect(listed).not.toContain(`href="/staff/volunteer/credit/${FAMILY_B.family.qboId}"`);
    expect(list).toContain(`${FAMILY_A.family.name} 1 credit`);
    expect(list).toContain(`${FAMILY_B.family.name} 1 credit`);
  });

  it("credits volunteering done outside the portal: the requirement, who did it, the amount in its unit and a note, each checked", async () => {
    const { a, b, famA, famB, hours, tag } = await shared();
    const add = (f: Partial<{ familyId: string; requirementId: string; who: string; amount: string; note: string }>) =>
      addOutsideCreditAction(tag, f.familyId ?? famA, { requirementId: f.requirementId ?? hours.id, who: f.who ?? "family", amount: f.amount ?? "1.5", note: f.note ?? "Painted the set" });
    // A per-student requirement in shifts, asked of every student.
    const spring = await seedSeason({ name: "Spring", current: false, steps: [{ name: "Help" }] });
    const [own] = await db.insert(requirement).values({ stepId: spring.stepIds.Help!, kind: "volunteer", title: "Own shifts", appliesTo: "student", amount: 2, amountUnit: "shifts", position: 0 }).returning();
    const ownId = own!.id;
    const checklist = (await db.select().from(requirement).where(eq(requirement.kind, "checklist")))[0]!;
    const [aurelio, barnaby] = [await idOf(studentOf(AURELIO!.qboId)), await idOf(studentOf(FAMILY_B.students[0]!.qboId))];
    const refusals: [Parameters<typeof add>[0], string][] = [
      [{ note: "  " }, "Add a note saying what was done. Only staff see it."],
      [{ familyId: NO_SUCH }, "That family isn't on the roster now. Reload the page."],
      // A student's record named as the family.
      [{ familyId: aurelio }, "That family isn't on the roster now. Reload the page."],
      [{ requirementId: checklist.id }, "That requirement isn't there any more, or isn't a volunteering one. Reload the page."],
      [{ requirementId: NO_SUCH }, "That requirement isn't there any more, or isn't a volunteering one. Reload the page."],
      [{ who: aurelio }, "Choose who did it."],
      [{ requirementId: ownId, who: "family", amount: "1" }, "Choose which of the family's students did it."],
      // A student of the other family, named on family A's page.
      [{ requirementId: ownId, who: barnaby, amount: "1" }, "Choose which of the family's students did it."],
      // Family B's own record named as the student.
      [{ requirementId: ownId, who: famB, amount: "1" }, "Choose which of the family's students did it."],
      [{ amount: "0" }, "Enter the hours as a number more than 0 and up to 200, such as 2 or 1.5."],
      [{ amount: "1.255" }, "Enter the hours as a number more than 0 and up to 200, such as 2 or 1.5."],
      [{ amount: "two" }, "Enter the hours as a number more than 0 and up to 200, such as 2 or 1.5."],
      [{ requirementId: ownId, who: aurelio, amount: "1.5" }, "Enter a whole number of shifts, from 1 to 50."],
    ];
    for (const [f, error] of refusals) expect(await add(f!), JSON.stringify(f)).toEqual({ ok: false, errors: [error] });
    // A chosen list that doesn't name the family.
    await db.update(requirement).set({ covers: "chosen" }).where(eq(requirement.id, hours.id));
    expect(await add({})).toEqual({ ok: false, errors: [`${TWO_FAMILY_HOURS} isn't asked of ${FAMILY_A.family.name}, so credit can't count toward it.`] });
    await db.update(requirement).set({ covers: "everyone" }).where(eq(requirement.id, hours.id));
    const before = await credits();
    expect(await add({ amount: " 1.5 ", note: " Painted the set  for the show " })).toEqual({ ok: true, message: "Credited. The family sees it as added by the club; only staff see the note." });
    expect(await add({ requirementId: ownId, who: aurelio, amount: "2" })).toMatchObject({ ok: true });
    const made = (await credits()).filter((c) => !before.some((x) => x.id === c.id));
    expect(made.map((c) => ({ ...c, familyId: String(c.familyId), studentId: c.studentId === null ? null : String(c.studentId) }))).toMatchObject([
      { kind: "outside", familyId: famA, studentId: null, requirementId: hours.id, minutes: 90, shifts: 0, note: "Painted the set for the show", createdByDoor: "staff", createdBy: writer.id },
      { kind: "outside", familyId: famA, studentId: aurelio, requirementId: ownId, minutes: 0, shifts: 2 },
    ]);
    expect((await audits("volunteer.credit.outside.add"))[0]).toMatchObject({ before: null, after: { familyId: famA, studentId: null, requirement: TWO_FAMILY_HOURS, who: FAMILY_A.family.name, minutes: 90, note: "Painted the set for the show" } });
    // The family reads "Added by the club" and the amount, never the note; the other family reads nothing of it.
    asParent(a.identity);
    const page = textOf(await renderPage(VolunteerPage));
    expect(page).toContain(`1.5 hours toward ${TWO_FAMILY_HOURS} Added by the club · Your family`);
    expect(page).toContain("4.5 of 6 hours done");
    expect(page).not.toContain("Painted the set");
    asParent(b.identity);
    expect(textOf(await renderPage(VolunteerPage))).not.toContain("1.5 hours");
  });
});

describe("credit already earned stays", () => {
  it("when a shift's time or code changes, and when the shift is cancelled", async () => {
    const { a, shift, forA } = await shared();
    expect(await updateShiftAction(shift.id, { startsAt: "10:00", endsAt: "11:00", places: 4, role: "Rinse crew", requirementIds: (await db.select().from(requirement).where(eq(requirement.title, TWO_FAMILY_HOURS))).map((r) => r.id) })).toMatchObject({ ok: true });
    expect(await renewCheckInCodeAction(shift.id)).toMatchObject({ ok: true });
    expect(await cancelShiftAction(shift.id)).toMatchObject({ ok: true });
    expect((await live()).find((c) => c.signupId === forA.id)).toMatchObject({ minutes: 180, shifts: 1 });
    asParent(a.identity);
    expect(textOf(await renderPage(VolunteerPage))).toContain("3 of 6 hours done");
  });
});

describe("a different QuickBooks company", () => {
  // Since stage 4's slice M7a the clear a change of company would run keeps volunteering (open question 16), as the
  // families and students it names are kept: it was "clears every credit and reminder claim with the sign-ups" while the
  // clear removed those records too. Since slice M8 a switch an Admin asks for reaches it; this calls it directly.
  it("keeps every credit, removed ones too, every reminder claim and sign-up, and every shift as it was", async () => {
    const { b, forB } = await shared();
    await seedCheckIn({ signupId: forB.id, familyQboId: FAMILY_B.family.qboId, by: b.identity.parentId, removed: { by: writer.id, reason: "Mistake" } });
    await db.insert(volunteerReminder).values({ kind: "day_before", key: `${forB.id}|2027-01-01`, familyId: await familyOf(FAMILY_B.family.qboId), triedAt: new Date(), outcome: "sent" });
    const rows = async () => ({
      credits: await db.select().from(volunteerCredit).orderBy(asc(volunteerCredit.id)),
      reminders: await db.select().from(volunteerReminder).orderBy(asc(volunteerReminder.id)),
      signups: await db.select().from(volunteerSignup).orderBy(asc(volunteerSignup.id)),
      shifts: await db.select().from(volunteerShift).orderBy(asc(volunteerShift.id)),
    });
    const before = await rows();
    expect([before.credits.length, before.credits.filter((c) => c.removedAt !== null).length, before.reminders.length, before.signups.length]).toEqual([3, 1, 1, 2]);
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    expect(await clearRosterOfOtherCompany("9130000000000002", { actor: { door: "staff", id: null, label: "admin" }, ip: null })).toBe(true);
    expect(await rows()).toEqual(before);
    expect(await audits("volunteer.signups.cleared")).toEqual([]);
  });
});

describe("a student moved to another family (for the roster writes slice)", () => {
  it("gives up the old family's places for the student on shifts still to start, tells the guardian afterward, and leaves earned credit with the old family", async () => {
    const { a, forA } = await shared();
    // The shared shift is A's student's, checked in (credit earned): kept. Two more places: one still to start, one under way.
    const { shifts: [later] } = await seedEvent({ name: "Spring fling", inDays: 10, shifts: [{ startsAt: "10:00", endsAt: "12:00" }] });
    const toGiveUp = await seedSignup({ shiftId: later!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO! });
    const t = shiftAround(new Date(), 10, 60);
    const { shifts: [now] } = await seedEvent({ name: "Under way", onDate: t.onDate, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt }] });
    const underWay = await seedSignup({ shiftId: now!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO! });
    const move = { studentId: await studentOf(AURELIO!.qboId), fromFamilyId: await familyOf(FAMILY_A.family.qboId), toFamilyId: await familyOf(FAMILY_B.family.qboId) };
    const moved = await db.transaction((tx) => volunteerForMovedStudent(tx, move));
    expect(moved.cancelled).toBe(1);
    expect(mail.outbox).toEqual([]); // nothing goes until the move is committed and tell() is called
    expect(await moved.tell()).toEqual({ sent: 1, failed: 0 });
    const liveIds = (await db.select().from(volunteerSignup).where(isNull(volunteerSignup.cancelledAt))).map((s) => s.id);
    expect(liveIds).not.toContain(toGiveUp.id);
    expect(liveIds).toEqual(expect.arrayContaining([forA.id, underWay.id]));
    expect(mail.outbox.map((m) => [m.to, m.subject])).toEqual([[FAMILY_A.parent.email, "Your place has been freed: Spring fling"]]);
    expect(mail.outbox[0]!.text).toContain(`${AURELIO!.name}'s place on a shift at Spring fling (Concessions) has been freed, because ${AURELIO!.name} is no longer listed with your family in the club's records.`);
    expect(mail.outbox[0]!.text).not.toContain(FAMILY_B.family.name);
    // The move comes by the app's own records, and the audit row names them.
    expect((await audits("volunteer.signup.moved"))[0]).toMatchObject({ targetType: "student", targetId: await idOf(studentOf(AURELIO!.qboId)),
      before: { familyId: await idOf(familyOf(FAMILY_A.family.qboId)) }, after: { familyId: await idOf(familyOf(FAMILY_B.family.qboId)), cancelled: 1, guardiansTold: 1 } });
    expect((await live()).find((c) => c.signupId === forA.id)).toMatchObject({ familyId: await familyOf(FAMILY_A.family.qboId) });
    // Nothing to give up the second time.
    expect((await db.transaction((tx) => volunteerForMovedStudent(tx, move))).cancelled).toBe(0);
  });
});
