import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// The request a page is rendered for, so getParentState() can be asked what the portal makes of a browser's cookie:
// the real Better Auth session read, the real re-check and the real renewal, with only the request itself made up.
import { fromBrowser } from "../helpers/page-request";

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, parent, parentAuthAccount, parentAuthSession, parentAuthUser, parentAuthVerification, rateLimitEvent, signinCode, student } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { getParentState } from "@/lib/auth/identity";
import { resolveParentSession } from "@/lib/auth/resolve";
import { chooseFamily, completeParentSignin } from "@/lib/parents/family-choice";
import { blockPerson } from "@/lib/parents/people";
import { setRequireStudents } from "@/lib/parents/switches";
import { endParentSessions, enterableGuardianRows, guardianRowCounts, hasRowThatCounts, renewParentSession, studentsRuleInForce } from "@/lib/parents/sessions";
import { getParentSettings } from "@/lib/parents/settings";
import { sendOwedWelcomes } from "@/lib/parents/welcome";
import { env } from "@/env";
import { asAppFamilyId, type AppFamilyId } from "@/lib/families/ids";
// Each person is seeded in a family of the app's own (seedGuardianInFamily()): the gate lets a parent in only through an
// open row naming an active family record.
import { resetDb, seedParent, seedGuardian, seedGuardianInFamily, seedParentSession, seedWorkingMail } from "../helpers/db";
// Every sign-in goes through the door as a browser's does: the password, then the code it mails (the sign-in release, slice SI-3b).
import { DOOR_IP, DOOR_PASSWORD, codeMailed, codeStep, cookieNamed, passwordStep, postDoor, signInThroughDoor } from "../helpers/parent-door";
import { seedCode, seedPassword } from "../helpers/signin-links";
import { SIGNINS_ON, seedParentSettings, storeShape } from "../helpers/roster-cache";

const IP = DOOR_IP;
const staff = { actor: { door: "staff" as const, id: null, label: "board" }, ip: null };
/** A membership closed, as closeMembership() closes one: the row is disabled, and the sessions end if it was the last. */
async function dropRow(guardianId: string) {
  const [row] = await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, guardianId)).returning();
  const open = await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, row!.parentId), ne(guardian.status, "disabled")));
  if (open.length === 0) await endParentSessions(row!.parentId);
}
const post = (path: string, body: unknown, cookie?: string) => postDoor(path, body, { cookie });
const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
async function getSession(cookie: string) {
  const auth = await getParentAuth();
  const res = await auth.handler(new Request(`${env.APP_URL}/api/auth/parent/get-session`, { headers: { cookie, origin: env.APP_URL } }));
  return (await res.json()) as { session: { id: string; userId: string; familyId?: string | null; expiresAt: string } } | null;
}
/** Signed in through the door: the password (given one when the person has none), then the code it mails. The session's cookie alone. */
async function signIn(email: string, extra: { next?: string } = {}) {
  const r = await signInThroughDoor(outbox, email, extra);
  return { res: r.res, body: r.body, cookie: cookieNamed(r.res, "session_token") };
}
const DAY = 86_400_000;
/** What the portal makes of a page request from a browser holding this cookie. */
const pageRequest = async (cookie: string) => { fromBrowser(cookie); return getParentState(); };
/** Moves every stored time of the session back, as if this long had passed since they were written. */
async function timePasses(ms: number) {
  const [row] = await db.select().from(parentAuthSession);
  const back = (d: Date) => new Date(d.getTime() - ms);
  await db.update(parentAuthSession).set({ createdAt: back(row!.createdAt), updatedAt: back(row!.updatedAt), expiresAt: back(row!.expiresAt) });
}
const sessionRow = async () => (await db.select().from(parentAuthSession))[0]!;
const near = (actual: number, wanted: number) => { expect(actual).toBeGreaterThan(wanted - 10_000); expect(actual).toBeLessThan(wanted + 10_000); };
const stateOf = async (cookie: string) => {
  const s = (await getSession(cookie))!;
  // The session's family as /get-session answers it: the uuid of the app's family record it stores, or null.
  return resolveParentSession({ id: s.session.id, userId: s.session.userId, familyId: s.session.familyId ? asAppFamilyId(s.session.familyId) : null });
};

describe("the parent door", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

  it("answers the password step the same for unknown, blocked, all-disabled and a wrong password, and mails a code only for the right one", async () => {
    for (const [email, o] of [["ana@example.com", {}], ["ben@example.com", { blocked: true }], ["cy@example.com", {}]] as const) {
      const p = await seedParent({ name: email, email, ...o });
      if (email === "cy@example.com") await seedGuardianInFamily({ parentId: p.id, familyQboId: "F1", status: "disabled", disabledReason: "removed" });
      else await seedGuardianInFamily({ parentId: p.id, familyQboId: "F1" });
      await seedPassword(p.authUserId, DOOR_PASSWORD);
    }
    const answers = [];
    for (const [email, password] of [["nobody@example.com", DOOR_PASSWORD], ["ben@example.com", DOOR_PASSWORD], ["cy@example.com", DOOR_PASSWORD],
      ["ana@example.com", "not the password at all"]]) {
      const res = await post("/portal-password/check", { email, password });
      answers.push([res.status, await res.text(), res.headers.getSetCookie()]);
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0]).toEqual([200, JSON.stringify({ ok: false, error: "rejected" }), []]);
    expect(outbox).toEqual([]);
    const right = await post("/portal-password/check", { email: "ana@example.com", password: DOOR_PASSWORD });
    expect(await right.json()).toEqual({ ok: true, step: "code" });
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    expect(outbox[0]!.to).toBe("ana@example.com");
    // A right password on a device the portal doesn't remember makes no session: only the pending step.
    expect(cookieNamed(right, "session_token")).toBe("");
    expect(cookieNamed(right, "signin_step")).not.toBe("");
    expect(await db.select().from(parentAuthSession)).toEqual([]);
  });

  it("a code check answers the same for a wrong code with a pending step and for no pending step at all", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    await seedPassword(a.authUserId, DOOR_PASSWORD);
    const { pending } = await passwordStep("ana@example.com");
    const code = await codeMailed(outbox, "ana@example.com", 0);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const r1 = await codeStep(wrong, pending);
    const r2 = await codeStep(wrong, "");
    expect(r1.body).toEqual(r2.body);
    expect(r1.body).toEqual({ ok: false, error: "rejected" });
    expect(cookieNamed(r1.res, "session_token")).toBe("");
  });

  it("signs nobody in with a code alone: no pending step, a forged one, or another person's; and the old code doors are gone", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const b = await seedParent({ name: "Ben", email: "ben@example.com" }); await seedGuardianInFamily({ parentId: b.id, familyQboId: "F2" });
    await seedPassword(b.authUserId, DOOR_PASSWORD);
    // Ben's own pending step, from his right password.
    const { pending: bens } = await passwordStep("ben@example.com");
    expect(bens).not.toBe("");
    // A live code for Ana, as if one had been mailed to her.
    await seedCode(a.id, { code: "246810" });
    const name = bens.split("=")[0]!;
    const forged = Buffer.from(JSON.stringify({ p: a.id, e: "ana@example.com", c: "x", u: Date.now(), x: Date.now() + 60_000 })).toString("base64url");
    for (const cookie of ["", `${name}=${forged}`, `${name}=${encodeURIComponent(`${forged}.${"A".repeat(43)}=`)}`, bens]) {
      const r = await codeStep("246810", cookie);
      expect([cookie, r.body]).toEqual([cookie, { ok: false, error: "rejected" }]);
      expect(cookieNamed(r.res, "session_token")).toBe("");
    }
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await db.select().from(signinCode)).find((c) => c.parentId === a.id)).toMatchObject({ usedAt: null });
    for (const path of ["/portal-code/send", "/portal-code/verify"]) {
      const r = await post(path, { email: "ana@example.com", code: "246810" });
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect(await db.select().from(parentAuthSession)).toEqual([]);
  });

  it("with one family, goes straight in, activates invited rows and audits the sign-in with the family", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const { body, cookie } = await signIn("ana@example.com");
    expect(body).toEqual({ ok: true, next: "/" });
    const state = await stateOf(cookie);
    expect(state).toMatchObject({ status: "ok", identity: { parentId: a.id, familyId: g.familyId, guardianId: g.id, families: [{ guardianId: g.id, familyId: g.familyId }] } });
    // The identity names the app's family alone, and the session stores no QuickBooks id: the record's own.
    expect(JSON.stringify(state)).not.toContain('"F1"');
    expect(await sessionRow()).toMatchObject({ familyId: g.familyId });
    expect(await sessionRow()).not.toHaveProperty("familyQboId");
    expect((await db.select().from(guardian))[0]!.status).toBe("active");
    const rows = await db.select().from(auditLog);
    expect(rows.filter((x) => x.action === "guardian.activate")).toHaveLength(1);
    expect(rows.find((x) => x.action === "signin")).toMatchObject({ door: "parent", actorId: a.id, targetType: "parent", targetId: a.id, after: { familyId: String(g.familyId) }, ip: IP });
  });

  it("activates every invited link at once, audits each, and leaves a closed link closed", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const one = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const two = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F2", status: "invited" });
    const shut = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F3", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
    expect(await completeParentSignin(a.id, IP)).toEqual({ familyId: null });                // two families: the parent chooses
    const status = Object.fromEntries((await db.select().from(guardian)).map((g) => [g.id, g.status]));
    expect(status).toEqual({ [one.id]: "active", [two.id]: "active", [shut.id]: "disabled" });
    const activated = (await db.select().from(auditLog)).filter((x) => x.action === "guardian.activate");
    expect(activated.map((x) => x.targetId).sort()).toEqual([one.id, two.id].sort());
    for (const row of activated) expect(row).toMatchObject({ door: "parent", actorId: a.id, before: { status: "invited" }, after: { status: "active" }, ip: IP });
    expect((await db.select().from(auditLog)).some((x) => x.action === "signin")).toBe(false);
  });

  it("activates nothing and records no sign-in for a session that was ended while it was being made", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const live = await seedParentSession(a.authUserId);
    await endParentSessions(a.id);                                       // a block or a change of address got there first
    expect(await completeParentSignin(a.id, IP, live.id)).toEqual({ familyId: null, sessionEnded: true });
    expect((await db.select().from(guardian))[0]).toMatchObject({ id: g.id, status: "invited" });
    expect(await db.select().from(auditLog)).toEqual([]);
    // The session that is still there is entered into the one family, and audited.
    const kept = await seedParentSession(a.authUserId);
    expect(await completeParentSignin(a.id, IP, kept.id)).toEqual({ familyId: g.familyId });
    expect((await db.select().from(parentAuthSession))[0]).toMatchObject({ id: kept.id, familyId: g.familyId });
    expect((await db.select().from(auditLog)).map((x) => x.action)).toEqual(["guardian.activate", "signin"]);
  });

  it("signs a parent out on their next request when an Admin switched sign-ins off after they got in", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    expect(await stateOf(cookie)).toMatchObject({ status: "ok" });
    await seedParentSettings({ signin: false });
    expect(await stateOf(cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await db.select().from(auditLog)).filter((x) => x.action === "signin.refused").at(-1)).toMatchObject({
      door: "parent", actorId: a.id, targetType: "parent", targetId: a.id, after: { reason: "signins_off" } });
  });

  it("with two families, asks first; choosing audits the sign-in, choosing again audits a switch", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const f1 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" }), f2 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F2" });
    const { body, cookie } = await signIn("ana@example.com");
    expect(body).toEqual({ ok: true, next: "/choose-family" });
    const first = await stateOf(cookie);
    expect(first).toMatchObject({ status: "choose", families: [{ guardianId: f1.id, familyId: f1.familyId }, { guardianId: f2.id, familyId: f2.familyId }] });
    const sessionId = first.status === "choose" ? first.sessionId : "";
    // A family is chosen by the person's own guardian row; the session is given that row's family.
    expect(await chooseFamily({ sessionId, parentId: a.id, guardianId: f2.id, ip: IP })).toBe(true);
    expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { familyId: f2.familyId } });
    expect(await chooseFamily({ sessionId, parentId: a.id, guardianId: f1.id, ip: IP })).toBe(true);
    const rows = await db.select().from(auditLog);
    // Both name the app's family records, never a QuickBooks id.
    expect(rows.filter((x) => x.action === "signin").map((x) => x.after)).toEqual([{ familyId: String(f2.familyId) }]);
    expect(rows.find((x) => x.action === "signin.family_switch")!.after).toEqual({ from: String(f2.familyId), to: String(f1.familyId) });
    const stranger = await seedGuardianInFamily({ parentId: (await seedParent({ name: "Bo", email: "bo@example.com" })).id, familyQboId: "F2" });
    for (const guardianId of [crypto.randomUUID(), stranger.id]) {
      expect(await chooseFamily({ sessionId, parentId: a.id, guardianId, ip: IP })).toBe(false);
      // Found by what it records, never by its place among the rows.
      const refused = (await db.select().from(auditLog)).filter((x) => x.action === "signin.refused"
        && (x.after as { guardianId?: string } | null)?.guardianId === guardianId);
      expect(refused.map((x) => x.after)).toEqual([{ reason: "family_not_enabled", guardianId }]);
    }
    expect((await db.select().from(auditLog)).filter((x) => x.action === "signin.refused")).toHaveLength(2);
    expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { familyId: f1.familyId } });
  });

  it("sends a parent back to choose when the chosen family goes away and another is left", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g1 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" }), g2 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F2" });
    const { cookie } = await signIn("ana@example.com");
    const s = await stateOf(cookie);
    await chooseFamily({ sessionId: s.status === "choose" ? s.sessionId : "", parentId: a.id, guardianId: g1.id, ip: IP });
    await dropRow(g1.id);
    expect(await stateOf(cookie)).toMatchObject({ status: "choose", families: [{ guardianId: g2.id, familyId: g2.familyId }] });
    expect((await db.select().from(parentAuthSession))[0]!.familyId).toBeNull();
    expect((await db.select().from(auditLog)).find((x) => x.action === "signin.refused")!.after).toEqual({ reason: "family_not_enabled", familyId: String(g1.familyId) });
  });

  it("signs a parent out at once when their last family goes, or they're blocked", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const one = await signIn("ana@example.com");
    await dropRow(g.id);
    expect(await getSession(one.cookie)).toBeNull();
    const b = await seedParent({ name: "Ben", email: "ben@example.com" }); await seedGuardianInFamily({ parentId: b.id, familyQboId: "F2" });
    outbox.length = 0;
    const two = await signIn("ben@example.com");
    await blockPerson(b.id, "reason", staff);
    expect(await getSession(two.cookie)).toBeNull();
  });

  it("lasts 90 days from sign-in, with a cookie that outlives it", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { res } = await signIn("ana@example.com");
    const row = await sessionRow();
    near(row.expiresAt.getTime() - row.createdAt.getTime(), 90 * DAY);
    // The cookie is sent this once. It is given the longest life browsers allow (400 days), so the row decides.
    const sent = res.headers.getSetCookie().filter((c) => c.startsWith("br_parent.session_token="));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/;\s*Max-Age=34560000(;|$)/i);
    expect(sent[0]).toMatch(/;\s*HttpOnly(;|$)/i);
    expect(sent[0]).toMatch(/;\s*SameSite=Lax(;|$)/i);
  });

  it("starts its 90 days again when it is used, at most once a day", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const made = await sessionRow();
    // Used again the same day: nothing is written.
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    expect(await sessionRow()).toEqual(made);
    await timePasses(23 * 60 * 60 * 1000);
    const unrenewed = await sessionRow();
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    expect(await sessionRow()).toEqual(unrenewed);
    // A day after it was made: this use moves the end to 90 days from now.
    await timePasses(2 * 60 * 60 * 1000);
    const dayOld = await sessionRow();
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    const renewed = await sessionRow();
    near(renewed.expiresAt.getTime(), Date.now() + 90 * DAY);
    near(renewed.updatedAt.getTime(), Date.now());
    // Nothing else about the session changes: it is the same one, made when it was made.
    expect(renewed).toEqual({ ...dayOld, expiresAt: renewed.expiresAt, updatedAt: renewed.updatedAt });
    expect(renewed).toMatchObject({ id: made.id, token: made.token, familyId: g.familyId });
    // And the next use that day leaves it alone again.
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    expect(await sessionRow()).toEqual(renewed);
  });

  it("is renewed for a parent who has yet to choose a family, too", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F2" });
    const { cookie } = await signIn("ana@example.com");
    await timePasses(3 * DAY);
    expect(await pageRequest(cookie)).toMatchObject({ status: "choose" });
    near((await sessionRow()).expiresAt.getTime(), Date.now() + 90 * DAY);
  });

  it("still takes the same cookie after the first 90 days, when use has kept the session going", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    // Day 80: used, so the session now ends on day 170.
    await timePasses(80 * DAY);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok", identity: { parentId: a.id } });
    // Day 150: 60 days past the end it was given at sign-in. The cookie from sign-in is still the one presented.
    await timePasses(70 * DAY);
    near(Date.now() - (await sessionRow()).createdAt.getTime(), 150 * DAY);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok", identity: { parentId: a.id, familyId: g.familyId } });
    near((await sessionRow()).expiresAt.getTime(), Date.now() + 90 * DAY);
  });

  it("refuses and removes a session that was not used for 90 days", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    await timePasses(89 * DAY);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });      // day 89: still in, and renewed
    await timePasses(90 * DAY + 1000);                                       // then away for 90 days
    expect(await pageRequest(cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await pageRequest(cookie)).toEqual({ status: "none" });           // and the cookie opens nothing afterward
    expect((await db.select().from(auditLog)).some((x) => x.action === "signout")).toBe(false); // running out is not a sign-out
  });

  it("does not bring a session back once it has run out", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    await signIn("ana@example.com");
    await timePasses(90 * DAY + 1000);
    const row = await sessionRow();
    expect(await renewParentSession({ id: row.id, expiresAt: row.expiresAt })).toBe(false);
    // Even told the session was live a moment ago, the update only matches a row that still is.
    expect(await renewParentSession({ id: row.id, expiresAt: new Date(Date.now() + DAY) })).toBe(false);
    expect((await sessionRow()).expiresAt).toEqual(row.expiresAt);
  });

  it("is not renewed for a session the portal refuses", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    await timePasses(3 * DAY);
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.id));
    expect(await pageRequest(cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
  });

  it("is neither renewed nor given a new cookie by Better Auth's own get-session", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    await timePasses(3 * DAY);
    const before = await sessionRow();
    const auth = await getParentAuth();
    const res = await auth.handler(new Request(`${env.APP_URL}/api/auth/parent/get-session`, { headers: { cookie, origin: env.APP_URL } }));
    expect(await res.json()).toMatchObject({ session: { id: before.id } });
    expect(res.headers.getSetCookie().filter((c) => c.startsWith("br_parent.session_token="))).toEqual([]);
    expect(await sessionRow()).toEqual(before);
    await db.update(parentAuthSession).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getSession(cookie)).toBeNull();
  });

  it("lands on the page the parent asked for, and only on a parent page of this site", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    expect((await signIn("ana@example.com", { next: "/display" })).body).toEqual({ ok: true, next: "/display" });
    const b = await seedParent({ name: "Ben", email: "ben@example.com" }); await seedGuardianInFamily({ parentId: b.id, familyQboId: "F1" });
    expect((await signIn("ben@example.com", { next: "//evil.example/display" })).body).toEqual({ ok: true, next: "/" });
    const c = await seedParent({ name: "Cy", email: "cy@example.com" }); await seedGuardianInFamily({ parentId: c.id, familyQboId: "F1" });
    expect((await signIn("cy@example.com", { next: "/staff/roster" })).body).toEqual({ ok: true, next: "/" });
    // With two families the chooser comes first, and carries the page with it.
    const d = await seedParent({ name: "Di", email: "di@example.com" });
    await seedGuardianInFamily({ parentId: d.id, familyQboId: "F1" }); await seedGuardianInFamily({ parentId: d.id, familyQboId: "F2" });
    expect((await signIn("di@example.com", { next: "/display" })).body).toEqual({ ok: true, next: "/choose-family?next=%2Fdisplay" });
    const e = await seedParent({ name: "Ed", email: "ed@example.com" });
    await seedGuardianInFamily({ parentId: e.id, familyQboId: "F1" }); await seedGuardianInFamily({ parentId: e.id, familyQboId: "F2" });
    expect((await signIn("ed@example.com", { next: "https://evil.example/" })).body).toEqual({ ok: true, next: "/choose-family" });
  }, 30_000);

  it("is configured so a session is read from the database on every request and never refreshed by Better Auth", async () => {
    const o = (await getParentAuth()).options;
    expect(o.session?.disableSessionRefresh).toBe(true);
    expect(o.session?.expiresIn).toBe(90 * 24 * 60 * 60);
    // Not declared at all in our config, so the type has no such key; read it loosely.
    expect((o.session as { cookieCache?: { enabled?: boolean } } | undefined)?.cookieCache?.enabled ?? false).toBe(false);
    expect(o.advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-booster-client-ip"]); // written by the portal itself: tests/integration/client-address.test.ts
    expect(o.emailAndPassword?.enabled).toBe(false);
    // In front of the database limits, an in-memory cap per IP on the door's three routes (on when NODE_ENV is production).
    // A minute of it allows what the database allows in 15, so it is never the first limit a full room meets.
    expect(o.rateLimit?.customRules).toEqual({
      "/portal-password/check": { window: 60, max: 180 }, "/portal-code/resend": { window: 60, max: 60 }, "/portal-code/check": { window: 60, max: 180 },
    });
    expect((o.rateLimit as { enabled?: boolean } | undefined)?.enabled).toBeUndefined(); // Better Auth's default: on only in production
  });

  it("over the check limit, says so", async () => {
    for (let i = 0; i < 180; i++) await post("/portal-code/check", { code: "123456" });
    const res = await post("/portal-code/check", { code: "123456" });
    expect(await res.json()).toEqual({ ok: false, error: "rate_limited" });
  }, 60_000);

  it("answers not found, and changes nothing, on every Better Auth endpoint a parent could write through", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const auth = await getParentAuth();
    const call = (path: string, method: "GET" | "POST", body: unknown = {}) => auth.handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
      method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      headers: { "content-type": "application/json", origin: env.APP_URL, "cf-connecting-ip": IP, cookie },
    }));
    const writes: [string, "GET" | "POST", unknown][] = [
      ["/update-user", "POST", { name: "Mallory", image: "https://evil.example/x.png" }],
      ["/update-session", "POST", { familyId: crypto.randomUUID() }],
      ["/revoke-sessions", "POST", {}], ["/revoke-other-sessions", "POST", {}], ["/revoke-session", "POST", { token: "x" }],
      ["/change-email", "POST", { newEmail: "mallory@example.com" }], ["/change-password", "POST", { currentPassword: "a", newPassword: "b" }],
      ["/delete-user", "POST", {}], ["/link-social", "POST", { provider: "microsoft" }], ["/unlink-account", "POST", { providerId: "x" }],
      ["/list-sessions", "GET", null], ["/list-accounts", "GET", null], ["/account-info", "GET", null],
    ];
    for (const [path, method, body] of writes) expect([path, (await call(path, method, body)).status]).toEqual([path, 404]);
    // And every other disabled path, both ways, so the list above can't fall behind the configuration.
    const disabled = auth.options.disabledPaths ?? [];
    expect(disabled.length).toBeGreaterThanOrEqual(writes.length);
    for (const path of disabled) for (const method of ["GET", "POST"] as const) expect([path, method, (await call(path, method)).status]).toEqual([path, method, 404]);
    const [u] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, a.authUserId));
    expect(u).toMatchObject({ name: "Ana", image: null, email: "ana@example.com" });
    expect(await db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, a.authUserId))).toHaveLength(1);
    // /get-session answers the session's own family as the app's record id, and no QuickBooks id of it.
    const answered = await getSession(cookie);
    expect(answered).toMatchObject({ session: { familyId: String(g.familyId) } });
    expect(JSON.stringify(answered)).not.toContain('"F1"');
    expect((await post("/sign-out", {}, cookie)).status).toBe(200);
    expect((await db.select().from(auditLog)).filter((x) => x.action === "signout")).toHaveLength(1);
  }, 30_000);

  it("leaves a parent only the endpoints the portal uses", async () => {
    const auth = await getParentAuth();
    const reachable = ["/get-session", "/sign-out", "/portal-password/check", "/portal-code/resend", "/portal-code/check", "/ok", "/error"];
    // Path-parameter routes can't be listed in disabledPaths (it matches exact paths). Neither can do anything here:
    // there are no social providers to call back to, and /reset-password/:token only redirects with a reset row of
    // Better Auth's own verification table, which the portal never writes: a person's password is set and reset by the
    // portal's own links (src/lib/parents/signin-links.ts), and the routes that would use it answer 404 (below).
    const parameterized = ["/callback/:id", "/reset-password/:token"];
    const paths = Object.values(auth.api).map((e) => (e as { path?: string }).path).filter((p): p is string => !!p);
    const disabled = new Set(auth.options.disabledPaths ?? []);
    expect(paths.filter((p) => !disabled.has(p)).sort()).toEqual([...reachable, ...parameterized].sort());
  });

  it("keeps Better Auth's password routes shut for a person who has a password", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const password = "the right password, long enough";
    await db.insert(parentAuthAccount).values({ id: crypto.randomUUID(), accountId: a.authUserId, providerId: "credential", userId: a.authUserId, password: await hashPassword(password) });
    const signIn = await post("/sign-in/email", { email: "ana@example.com", password });
    expect(signIn.status).toBe(404);
    expect(cookieFrom(signIn)).toBe("");
    const reset = await post("/reset-password", { newPassword: "a new password, long enough", token: "anything" });
    expect(reset.status).toBe(404);
    for (const path of ["/request-password-reset", "/change-password", "/verify-password"]) {
      expect([path, (await post(path, { email: "ana@example.com", password, currentPassword: password, newPassword: "another one, long enough" })).status]).toEqual([path, 404]);
    }
    // The one reachable route with a token in its path finds no reset row to act on: the portal never writes one.
    const auth = await getParentAuth();
    const callback = await auth.handler(new Request(`${env.APP_URL}/api/auth/parent/reset-password/anything?callbackURL=${encodeURIComponent(`${env.APP_URL}/sign-in`)}`,
      { headers: { origin: env.APP_URL, "cf-connecting-ip": IP } }));
    expect(callback.status).not.toBe(200);
    expect(callback.headers.get("location") ?? "").not.toContain("token=anything");
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await db.select().from(parentAuthVerification)).toEqual([]);
    // The password is the portal's as it was: one credential row, unchanged.
    const [cred] = await db.select().from(parentAuthAccount).where(eq(parentAuthAccount.userId, a.authUserId));
    expect(await verifyPassword({ hash: cred!.password!, password })).toBe(true);
  });

  it("records a sign-out through /sign-out against the person", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const res = await post("/sign-out", {}, cookie);
    expect(res.status).toBe(200);
    expect((await db.select().from(auditLog)).find((x) => x.action === "signout")).toMatchObject({ door: "parent", actorId: a.id, actorLabel: "ana@example.com", targetType: "parent", targetId: a.id, ip: IP });
    expect(await db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, a.authUserId))).toHaveLength(0);
  });
});

describe("the gate: a parent enters only an active family of the app's own (app-owned families spec section 6)", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });
  const makeInactive = (familyId: AppFamilyId | null) => db.update(family).set({ active: false }).where(eq(family.id, familyId!));
  const refusedFor = async (reason: string) => (await db.select().from(auditLog)).filter((x) => x.action === "signin.refused" && (x.after as { reason?: string } | null)?.reason === reason);

  it("sends a session whose family record went inactive back to choose, offering only the family that is still active", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g1 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" }), g2 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F2" });
    const { cookie } = await signIn("ana@example.com");
    const s = await stateOf(cookie);
    const sessionId = s.status === "choose" ? s.sessionId : "";
    expect(await chooseFamily({ sessionId, parentId: a.id, guardianId: g1.id, ip: IP })).toBe(true);
    expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { guardianId: g1.id, familyId: g1.familyId } });
    // Made inactive: the row is still open, the family is not one to enter.
    await makeInactive(g1.familyId);
    expect(await stateOf(cookie)).toEqual({ status: "choose", parentId: a.id, sessionId, name: "Ana", families: [{ guardianId: g2.id, familyId: g2.familyId }] });
    expect((await sessionRow()).familyId).toBeNull();
    expect((await refusedFor("family_not_enabled")).map((x) => x.after)).toEqual([{ reason: "family_not_enabled", familyId: String(g1.familyId) }]);
    // It can't be chosen again, and the gate closed nothing: both rows are as they were.
    expect(await chooseFamily({ sessionId, parentId: a.id, guardianId: g1.id, ip: IP })).toBe(false);
    expect((await db.select().from(guardian)).map((g) => g.status)).toEqual(["active", "active"]);
    expect(await chooseFamily({ sessionId, parentId: a.id, guardianId: g2.id, ip: IP })).toBe(true);
    expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { familyId: g2.familyId } });
  });

  it("offers no row that names no family record, and refuses a person with no row that counts as one with no open row", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    // A row the records were never brought into step for: it names no family record.
    const bare = await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const g2 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F2" });
    // The password is taken and the code sent and checked because one row counts, and that one family is entered at once.
    const { body, cookie } = await signIn("ana@example.com");
    expect(body).toEqual({ ok: true, next: "/" });
    const s = await stateOf(cookie);
    expect(s).toMatchObject({ status: "ok", identity: { guardianId: g2.id, familyId: g2.familyId, families: [{ guardianId: g2.id, familyId: g2.familyId }] } });
    expect((await db.select().from(auditLog)).find((x) => x.action === "signin")!.after).toEqual({ familyId: String(g2.familyId) });
    expect(await chooseFamily({ sessionId: s.status === "ok" ? s.identity.sessionId : "", parentId: a.id, guardianId: bare.id, ip: IP })).toBe(false);
    // Its family goes inactive too: nothing is left that counts, so the person is signed out as one with no open row.
    await makeInactive(g2.familyId);
    expect(await stateOf(cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await refusedFor("no_enabled_guardian")).toHaveLength(1);
    expect((await db.select().from(guardian)).map((g) => [g.id, g.status]).sort()).toEqual([[bare.id, "active"], [g2.id, "active"]].sort());
  });

  it.each([
    ["names an inactive family record", "inactive"],
    ["names no family record", "none"],
  ] as const)("a person whose only open row %s is refused at the password, sent no code and never signed in, as one with no open row", async (_, kind) => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = kind === "none" ? await seedGuardian({ parentId: a.id, familyQboId: "F1", status: "invited" })
      : await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });
    if (kind === "inactive") await makeInactive(g.familyId);
    await seedPassword(a.authUserId, DOOR_PASSWORD);
    const res = await post("/portal-password/check", { email: "ana@example.com", password: DOOR_PASSWORD });
    expect([res.status, await res.text()]).toEqual([200, JSON.stringify({ ok: false, error: "rejected" })]);   // the same answer as for anyone
    expect((await db.select().from(auditLog)).find((x) => x.action === "signin.password_refused")!.after).toEqual({ reason: "no_enabled_guardian" });
    expect(outbox).toEqual([]);
    // Nothing was activated, and nobody signed in.
    expect((await db.select().from(guardian))[0]).toMatchObject({ id: g.id, status: "invited" });
    expect((await db.select().from(auditLog)).filter((x) => x.action === "guardian.activate" || x.action === "signin")).toEqual([]);
  });

  it("a family that goes inactive between the code check and the sign-in's end: refused, nothing activated, no session left", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const live = await seedParentSession(a.authUserId);   // the session the plugin has just made
    await makeInactive(g.familyId);
    // sessionEnded: the plugin answers "rejected" and sets no cookie (parent-code-plugin.ts).
    expect(await completeParentSignin(a.id, IP, live.id)).toEqual({ familyId: null, sessionEnded: true });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await db.select().from(guardian))[0]).toMatchObject({ id: g.id, status: "invited" });
    const rows = await db.select().from(auditLog);
    expect(rows.filter((x) => x.action === "guardian.activate" || x.action === "signin")).toEqual([]);
    expect(rows.filter((x) => x.action === "signin.refused").map((x) => x.after)).toEqual([{ reason: "no_enabled_guardian" }]);
  });

  it("lets the same people into the same families as before in every ordinary state", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" }), ben = await seedParent({ name: "Ben", email: "ben@example.com" });
    const a1 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" });
    const b1 = await seedGuardianInFamily({ parentId: ben.id, familyQboId: "F1", status: "invited" });
    await seedGuardianInFamily({ parentId: ben.id, familyQboId: "F3", status: "disabled", disabledReason: "removed" });
    // Two guardians of one family share its record; a closed row is no family to enter.
    expect(b1.familyId).toBe(a1.familyId);
    for (const [who, row] of [["ana@example.com", a1], ["ben@example.com", b1]] as const) {
      const { body, cookie } = await signIn(who);
      expect(body).toEqual({ ok: true, next: "/" });
      expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { guardianId: row.id, familyId: a1.familyId, families: [{ guardianId: row.id, familyId: a1.familyId }] } });
    }
  });
});

describe("the gate: while the club asks for an active student, a family with none is not one to enter (open question 15)", () => {
  // The setting is switched on only while the membership shape names students, and is in force only then
  // (studentsRuleInForce()): the gate reads the stored shape for that, and never QuickBooks.
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); await storeShape(); });
  const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null, permission: "Settings.Parents.ReadWrite" };
  const refusedFor = async (action: string, reason: string) =>
    (await db.select().from(auditLog)).filter((x) => x.action === action && (x.after as { reason?: string } | null)?.reason === reason);
  const giveStudent = (familyId: AppFamilyId | null, active = true) => db.insert(student).values({ familyId: familyId!, name: "Sam", active });
  const statuses = async () => (await db.select().from(guardian)).map((g) => g.status).sort();
  /** As if the last code had been sent a while ago, so the next may be asked for at once, and no try is counted yet. */
  const ageCodes = async () => { await db.update(signinCode).set({ createdAt: new Date(Date.now() - 5 * 60_000) }); await db.delete(rateLimitEvent); };

  it("lets a family with no active student in while the setting is off, and with it on sends no code, refuses the check, and closes no row", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });
    await giveStudent(g.familyId, false);   // a student who left: not active
    // Off: students play no part.
    const before = await signIn("ana@example.com");
    expect(before.body).toEqual({ ok: true, next: "/" });
    expect(await stateOf(before.cookie)).toMatchObject({ status: "ok", identity: { guardianId: g.id } });
    // A code asked for while it is off, checked once it is on: refused at the check.
    outbox.length = 0;
    await ageCodes();
    const { pending } = await passwordStep("ana@example.com");
    const code = await codeMailed(outbox, "ana@example.com", 0);
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    const checked = (await codeStep(code, pending)).res;
    expect(checked.headers.getSetCookie().some((c) => c.startsWith("br_parent.session_token"))).toBe(false);
    expect(await refusedFor("signin.refused", "no_enabled_guardian")).toHaveLength(1);
    // The session already open is caught on its next request, as an inactive family's is.
    expect(await stateOf(before.cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    // On: the password is refused and no code is sent at all, with the same answer as for anyone.
    outbox.length = 0;
    await ageCodes();
    const send = await post("/portal-password/check", { email: "ana@example.com", password: DOOR_PASSWORD });
    expect([send.status, await send.text()]).toEqual([200, JSON.stringify({ ok: false, error: "rejected" })]);
    expect(await refusedFor("signin.password_refused", "no_enabled_guardian")).toHaveLength(1);
    expect(outbox).toEqual([]);
    // The setting closed nothing, and saved only itself.
    expect(await statuses()).toEqual(["active"]);
    expect((await db.select().from(auditLog)).filter((x) => x.action === "parent.access.ended")).toEqual([]);
    // Off again: the same row lets her in again.
    expect(await setRequireStudents(false, admin)).toEqual({ ok: true });
    await ageCodes();
    expect((await signIn("ana@example.com")).body).toEqual({ ok: true, next: "/" });
  });

  // An installation may hold the setting on beside a shape that names no students: before stage 3's slice 7a the
  // setting was in force only while the shape named a student type, and a shape save never switched it off. So it is in
  // force only then still, and nobody gains or loses access at the upgrade; the JavaScript rule and the SQL one agree.
  it("does not apply the setting stored on while the shape names no students, and applies it again once a shape does", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });   // no active student
    await seedParentSettings({ signin: true, welcome: true, requireActiveStudents: true });
    await db.update(parent).set({ welcomeOwed: true }).where(eq(parent.id, a.id));
    /** The rule as SQL, as the reminders read a row (guardianRowCounts()) and the welcome a person (hasRowThatCounts()). */
    const sqlSays = async () => {
      const rule = await studentsRuleInForce();
      const rows = await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.id, g.id), guardianRowCounts(rule)));
      const people = await db.select({ id: parent.id }).from(parent).where(and(eq(parent.id, a.id), hasRowThatCounts(rule)));
      return [rows.length === 1, people.length === 1];
    };
    const STALE = [{ kind: "flat" as const, memberTypeIds: ["M"] }, { kind: "layered" as const, familyTypeId: "F", studentTypeId: null, parentTypeId: "P" }];
    for (const [i, stale] of STALE.entries()) {
      await storeShape(stale);
      expect(await studentsRuleInForce()).toBe(false);
      expect((await enterableGuardianRows(a.id)).map((r) => r.id)).toEqual([g.id]);
      expect(await sqlSays()).toEqual([true, true]);
      // Welcomed (once), then given a code and signed in.
      outbox.length = 0;
      if (i === 0) {
        expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
        expect(outbox.map((m) => m.to)).toEqual(["ana@example.com"]);
        outbox.length = 0;
      }
      await ageCodes();
      const signedIn = await signIn("ana@example.com");
      expect(signedIn.body).toEqual({ ok: true, next: "/" });
      expect(await stateOf(signedIn.cookie)).toMatchObject({ status: "ok", identity: { guardianId: g.id } });
    }
    // A shape that names students: the stored value is in force again, by both rules, and she is sent no code until
    // the family has an active student. Nothing was switched or closed on the way.
    await storeShape();
    expect(await studentsRuleInForce()).toBe(true);
    expect(await getParentSettings()).toMatchObject({ requireActiveStudents: true });
    expect(await enterableGuardianRows(a.id)).toEqual([]);
    expect(await sqlSays()).toEqual([false, false]);
    outbox.length = 0;
    await ageCodes();
    await post("/portal-password/check", { email: "ana@example.com", password: DOOR_PASSWORD });
    expect(await refusedFor("signin.password_refused", "no_enabled_guardian")).toHaveLength(1);
    expect(outbox).toEqual([]);
    await giveStudent(g.familyId);
    expect((await enterableGuardianRows(a.id)).map((r) => r.id)).toEqual([g.id]);
    expect(await sqlSays()).toEqual([true, true]);
    expect(await statuses()).toEqual(["active"]);
  });

  it("offers the chooser only families with an active student while it is on, and sends back a session whose family lost its last one", async () => {
    await seedParentSettings({ requireActiveStudents: true });
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g1 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" }), g2 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F2" });
    const g3 = await seedGuardianInFamily({ parentId: a.id, familyQboId: "F3" });
    await giveStudent(g1.familyId); await giveStudent(g2.familyId);   // F3 has none
    const { cookie } = await signIn("ana@example.com");
    const s = await stateOf(cookie);
    expect(s).toMatchObject({ status: "choose", families: [{ guardianId: g1.id }, { guardianId: g2.id }] });
    const sessionId = s.status === "choose" ? s.sessionId : "";
    // The family with no active student can't be chosen, the same way as a row that isn't the person's.
    expect(await chooseFamily({ sessionId, parentId: a.id, guardianId: g3.id, ip: IP })).toBe(false);
    expect(await refusedFor("signin.refused", "family_not_enabled")).toHaveLength(1);
    expect(await chooseFamily({ sessionId, parentId: a.id, guardianId: g1.id, ip: IP })).toBe(true);
    expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { guardianId: g1.id } });
    // F1's last active student leaves: the session goes back to choose, offering F2 alone; no row closes.
    await db.update(student).set({ active: false }).where(eq(student.familyId, g1.familyId!));
    expect(await stateOf(cookie)).toMatchObject({ status: "choose", families: [{ guardianId: g2.id, familyId: g2.familyId }] });
    expect(await statuses()).toEqual(["active", "active", "active"]);
  });
});
