import { describe, it, expect, beforeEach, vi } from "vitest";
import { asParent, pageOutcome, renderPage, revalidatedPaths } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { asc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, setting, volunteerCredit } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import type { ParentCtx } from "@/lib/guards";
import { checkIn, loadCheckInForMe } from "@/lib/volunteer/check-in";
import { cancelMySignup } from "@/lib/volunteer/my-volunteer";
import { loadMyFamily } from "@/lib/parents/my-family";
import { VOLUNTEER_SETTINGS_KEY } from "@/lib/volunteer/settings";
import CheckInPage from "@/app/(parent)/volunteer/check-in/[code]/page";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import SeasonPage from "@/app/(parent)/season/page";
import { checkInAction } from "@/app/(parent)/volunteer/actions";
import { resetDb } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { TWO_FAMILY_HOURS, seedEvent, seedSignup, shiftAround } from "../helpers/volunteer";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Checking in with a shift's code (v1 spec §11.4) and the invariant the spec names for it (§12 invariant 8): a
 * check-in code credits only the signed-in family's own sign-up, and only inside its window. The page and the action
 * are called as family A with B's sign-up id, with the code of a shift only B is on, and with a right code outside its
 * window: nothing of B is shown and nothing is recorded.
 */
const ctxOf = (identity: ParentIdentity): ParentCtx => ({ ...identity, ip: "203.0.113.50" });
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
const leaked = (text: string, markers: string[]) => markers.filter((m) => text.toLowerCase().includes(m.toLowerCase()));
const credits = () => db.select().from(volunteerCredit).orderBy(asc(volunteerCredit.createdAt));
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const setZone = (timeZone: string) => db.insert(setting).values({ key: "club", value: { timeZone } }).onConflictDoUpdate({ target: setting.key, set: { value: { timeZone } } });
const NOT_FROM_PAGE = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const [AURELIO, AZALEA] = FAMILY_A.students;
const UNKNOWN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(async () => { await resetDb(); mail.outbox.length = 0; });

/** A shift whose window is open now (it started 10 minutes ago and ends in two hours), in the club's zone (UTC). */
async function openShift(name = "Tonight's concessions") {
  const t = shiftAround(new Date(), 10, 120);
  const { shifts: [shift] } = await seedEvent({ name, onDate: t.onDate, location: "North stand", shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt, places: 6, role: "Popcorn" }] });
  return shift!;
}

describe("invariant 8: a check-in code credits only the signed-in family's own sign-up, and only inside its window", () => {
  it("refuses B's sign-up, a shift only B is on, and a right code outside its window, records nothing of B, and checks in A's own", async () => {
    const { a, b } = await seedTwoFamilies();
    const tonight = await openShift();
    const forA = await seedSignup({ shiftId: tonight.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AURELIO! });
    const forB = await seedSignup({ shiftId: tonight.id, familyQboId: FAMILY_B.family.qboId, signedUpBy: b.identity.parentId, guardianName: FAMILY_B.parent.name });
    const onlyB = await openShift("Ticket booth");
    const bAlone = await seedSignup({ shiftId: onlyB.id, familyQboId: FAMILY_B.family.qboId, signedUpBy: b.identity.parentId, guardianName: FAMILY_B.parent.name });
    const bMarkers = [...b.markers, forB.id, bAlone.id];
    const before = await credits();
    asParent(a.identity);

    // B's sign-up, with the right code of a shift both are on, open now.
    expect(await checkInAction(tonight.checkinCode, forB.id)).toEqual(NOT_FROM_PAGE);
    // The code of a shift only B is on: by B's sign-up id, and "all".
    expect(await checkInAction(onlyB.checkinCode, bAlone.id)).toEqual(NOT_FROM_PAGE);
    expect(await checkInAction(onlyB.checkinCode, "all")).toEqual({ ok: false, errors: ["Nobody in your family is signed up for this shift, so there's no one to check in."] });
    const onlyBPage = textOf(await renderPage(CheckInPage, { params: { code: onlyB.checkinCode } }));
    expect(onlyBPage).toContain("Nobody in your family is signed up for this shift");
    expect(leaked(onlyBPage, bMarkers)).toEqual([]);
    // A right code, A's own sign-up, outside its window: the shared shift is 20 days away.
    const shared = a.volunteer!;
    const aShared = shared.markers[0]; // A's sign-up on the shared shift
    const early = await checkInAction(shared.code, aShared);
    expect(early.ok).toBe(false);
    expect((early as { errors: string[] }).errors[0]).toMatch(/^Check-in for this shift opens .+, half an hour before it starts\. Nothing was recorded\.$/);
    expect(await credits()).toEqual(before);
    expect(revalidatedPaths()).toEqual([]);

    // A's own page for the open shift shows A's own person, with a button, and nothing of B.
    const page = textOf(await renderPage(CheckInPage, { params: { code: tonight.checkinCode } }));
    expect(page).toContain(FAMILY_A.family.name);
    expect(page).toContain(`Check in ${AURELIO!.name}`);
    expect(leaked(page, bMarkers)).toEqual([]);
    expect(await checkInAction(tonight.checkinCode, forA.id)).toEqual({ ok: true, message: `Checked in: ${AURELIO!.name}. Thank you for helping!` });
    // Pressing twice gives one credit.
    expect(await checkInAction(tonight.checkinCode, forA.id)).toEqual({ ok: true, message: "Already checked in. Thank you for helping!" });
    const made = (await credits()).filter((c) => !before.some((x) => x.id === c.id));
    // The credit names the app's own family, and so does its audit row (stage 2 of the app-owned families spec).
    const aFamily = await recordOfCustomer(FAMILY_A.family.qboId, "family");
    expect(made).toMatchObject([{ kind: "checkin", signupId: forA.id, familyId: aFamily, studentId: null, minutes: 130, shifts: 1, createdByDoor: "parent", createdBy: a.identity.parentId }]);
    expect((await audits("volunteer.checkin.create")).map((r) => [r.targetId, (r.after as { familyId: string }).familyId])).toEqual([[made[0]!.id, String(aFamily)]]);
    expect(revalidatedPaths()).toContain("/");
    // B's place is untouched: B checks in for themselves.
    expect((await credits()).some((c) => c.signupId === forB.id)).toBe(false);
    const after = textOf(await renderPage(CheckInPage, { params: { code: tonight.checkinCode } }));
    expect(after).toContain("Checked in");
    expect(after).toContain("Everyone here is checked in");
  });

  it("answers a code that opens nothing with a 404, and records nothing for one no page could send", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    asParent(a.identity);
    for (const code of [UNKNOWN, "short", "has spaces in it and is long enough to pass length"]) {
      expect(await pageOutcome(CheckInPage, { params: { code } })).toEqual({ notFound: true });
    }
    const shift = await openShift();
    const mine = await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    // The shift's own id is not its code.
    expect(await pageOutcome(CheckInPage, { params: { code: shift.id } })).toEqual({ notFound: true });
    for (const [code, which] of [[UNKNOWN, mine.id], [shift.id, mine.id], [shift.checkinCode, "nope"], [shift.checkinCode, 7], [null, mine.id], [shift.checkinCode, { id: mine.id }]] as const) {
      expect(await checkInAction(code as never, which as never)).toEqual(NOT_FROM_PAGE);
    }
    expect(await credits()).toEqual([]);
  });

  it("checks in everyone of the family on the shift at once", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const shift = await openShift();
    await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: AZALEA! });
    asParent(a.identity);
    expect(textOf(await renderPage(CheckInPage, { params: { code: shift.checkinCode } }))).toContain("Check everyone in");
    expect(await checkInAction(shift.checkinCode, "all")).toEqual({ ok: true, message: `Checked in: you, ${AZALEA!.name}. Thank you for helping!` });
    expect(await credits()).toHaveLength(2);
    expect(await checkInAction(shift.checkinCode, "all")).toEqual({ ok: true, message: "Everyone here is checked in already. Thank you for helping!" });
    expect(await credits()).toHaveLength(2);
  });
});

describe("the check-in window", () => {
  const MARCH_10 = "2027-03-10";
  async function fixed(o: { startsAt: string; endsAt: string; onDate?: string }) {
    const a = await seedSignedInParent(FAMILY_A);
    const { shifts: [shift] } = await seedEvent({ onDate: o.onDate ?? MARCH_10, shifts: [{ startsAt: o.startsAt, endsAt: o.endsAt }] });
    const s = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    return { ctx: ctxOf(a.identity), code: shift!.checkinCode, signupId: s.id };
  }

  it("opens 30 minutes before the start and closes at the end, checked again when the press arrives", async () => {
    const { ctx, code, signupId } = await fixed({ startsAt: "18:00", endsAt: "21:00" });
    expect((await loadCheckInForMe(ctx, code, new Date("2027-03-10T17:29:59Z")))!).toMatchObject({ state: "before", opensWords: "Wednesday, March 10, 5:30 pm" });
    expect(await checkIn(ctx, code, signupId, new Date("2027-03-10T17:29:59Z"))).toEqual({ ok: false, errors: ["Check-in for this shift opens Wednesday, March 10, 5:30 pm, half an hour before it starts. Nothing was recorded."] });
    expect((await loadCheckInForMe(ctx, code, new Date("2027-03-10T21:00:00Z")))!.state).toBe("closed");
    expect(await checkIn(ctx, code, signupId, new Date("2027-03-10T21:00:00Z"))).toEqual({ ok: false,
      errors: ["Check-in for this shift has closed: it's over. Nothing was recorded. If you helped and weren't checked in, please tell Pat Organizer (pat.organizer@club.example)."] });
    expect(await credits()).toEqual([]);
    expect((await loadCheckInForMe(ctx, code, new Date("2027-03-10T17:30:00Z")))!.state).toBe("open");
    expect(await checkIn(ctx, code, signupId, new Date("2027-03-10T17:30:00Z"))).toMatchObject({ ok: true });
    expect(await credits()).toMatchObject([{ minutes: 180 }]);
  });

  it("is read in the club's zone, and stays open through the night for a shift that ends the next morning", async () => {
    await setZone("America/Chicago");
    const { ctx, code, signupId } = await fixed({ startsAt: "22:00", endsAt: "02:00" });
    // 10 pm CST on March 10 is 04:00 UTC on March 11; 2 am CST on March 11 is 08:00 UTC.
    expect((await loadCheckInForMe(ctx, code, new Date("2027-03-11T03:29:00Z")))!.state).toBe("before");
    expect((await loadCheckInForMe(ctx, code, new Date("2027-03-11T08:00:00Z")))!.state).toBe("closed");
    expect(await checkIn(ctx, code, signupId, new Date("2027-03-11T07:59:00Z"))).toMatchObject({ ok: true });
    expect(await credits()).toMatchObject([{ minutes: 240 }]);
  });

  it("credits the real length of a shift across the night the clocks go forward", async () => {
    await setZone("America/Chicago");
    // 2027-03-14: 2:00 am CST becomes 3:00 am CDT, so 1:00 to 5:00 am is three hours.
    const { ctx, code, signupId } = await fixed({ onDate: "2027-03-14", startsAt: "01:00", endsAt: "05:00" });
    expect(await checkIn(ctx, code, signupId, new Date("2027-03-14T09:59:00Z"))).toMatchObject({ ok: true });
    expect(await credits()).toMatchObject([{ minutes: 180 }]);
  });

  it("offers nothing and records nothing for a cancelled shift or event", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const t = shiftAround(new Date(), 10, 120);
    const { shifts: [cancelled] } = await seedEvent({ onDate: t.onDate, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt, cancelled: true }] });
    const { shifts: [ofCancelledEvent] } = await seedEvent({ onDate: t.onDate, cancelled: true, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt }] });
    asParent(a.identity);
    for (const shift of [cancelled!, ofCancelledEvent!]) {
      const s = await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
      const page = textOf(await renderPage(CheckInPage, { params: { code: shift.checkinCode } }));
      expect(page).toContain("The club cancelled this shift, so there's nothing to check in for.");
      expect(page).not.toContain("Check me in");
      expect(await checkInAction(shift.checkinCode, s.id)).toEqual({ ok: false, errors: ["The club cancelled this shift, so there's nothing to check in for."] });
    }
    expect(await credits()).toEqual([]);
  });
});

describe("after checking in", () => {
  it("can't be cancelled by the guardian, and is no longer \"signed up for\"", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await db.insert(setting).values({ key: VOLUNTEER_SETTINGS_KEY, value: { cutoffHours: 0 } });
    // Starts in 20 minutes: check-in is open, and with no cut-off it could still be cancelled.
    const t = shiftAround(new Date(), -20, 120);
    const { shifts: [shift] } = await seedEvent({ onDate: t.onDate, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt }] });
    const s = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    expect(await checkIn(ctxOf(a.identity), shift!.checkinCode, s.id)).toMatchObject({ ok: true });
    expect(await cancelMySignup(ctxOf(a.identity), await loadMyFamily(ctxOf(a.identity)), s.id)).toEqual({ ok: false, errors: ["This place is checked in already, so it can't be cancelled. Thank you for helping!"] });
    asParent(a.identity);
    const page = textOf(await renderPage(VolunteerPage));
    expect(page).toContain("Checked in");
    expect(page).not.toContain("Cancel my sign-up");
  });

  it("shows each family its own check-ins and outside credit, and the requirement lines in words from the rule", async () => {
    const { a, b } = await seedTwoFamilies();
    asParent(a.identity);
    const forA = textOf(await renderPage(VolunteerPage));
    expect(forA).toContain("Done so far");
    expect(forA).toMatch(/Marching band car wash, Rinse crew .* Checked in/);
    expect(forA).toContain("3 of 6 hours done");
    expect(forA).not.toContain("Added by the club");
    expect(leaked(forA, b.markers)).toEqual([]);
    asParent(b.identity);
    const forB = textOf(await renderPage(VolunteerPage));
    expect(forB).toContain(`2 hours toward ${TWO_FAMILY_HOURS} Your family Added by the club`);
    expect(forB).toContain("2 of 6 hours done, signed up for 3");
    // The note staff wrote is for staff alone, the family's own included.
    for (const note of b.season!.staffOnly) expect(forB).not.toContain(note);
    expect(leaked(forB, a.markers)).toEqual([]);
    const season = textOf(await renderPage(SeasonPage));
    expect(season).toContain(TWO_FAMILY_HOURS);
    expect(season).toContain("2 of 6 hours done, signed up for 3");
  });
});

describe("the rate limit", () => {
  it("refuses a guardian's 31st check-in press in 15 minutes, and audits the first refusal once", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const ctx = ctxOf(a.identity);
    for (let i = 0; i < 30; i++) expect(await checkIn(ctx, UNKNOWN, "all")).toEqual(NOT_FROM_PAGE);
    const limited = { ok: false, errors: ["That's a lot of check-ins in a few minutes. Please wait a little, then try again."] };
    expect(await checkIn(ctx, UNKNOWN, "all")).toEqual(limited);
    expect(await checkIn(ctx, UNKNOWN, "all")).toEqual(limited);
    expect(await audits("volunteer.checkin.refused")).toMatchObject([{ targetId: a.identity.parentId, after: { code: "rate_limited" } }]);
    // Another guardian has a count of their own.
    const other = await seedSignedInParent(FAMILY_B);
    expect(await checkIn(ctxOf(other.identity), UNKNOWN, "all")).toEqual(NOT_FROM_PAGE);
  });
});

