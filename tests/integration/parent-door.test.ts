import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// The request a page is rendered for, so getParentState() can be asked what the portal makes of a browser's cookie:
// the real Better Auth session read, the real re-check and the real renewal, with only the request itself made up.
import { fromBrowser } from "../helpers/page-request";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthSession, parentAuthUser } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { getParentState } from "@/lib/auth/identity";
import { resolveParentSession } from "@/lib/auth/resolve";
import { chooseFamily, completeParentSignin } from "@/lib/parents/family-choice";
import { blockPerson } from "@/lib/parents/people";
import { endParentSessions, enabledGuardianRows, renewParentSession } from "@/lib/parents/sessions";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardian, seedParentSession, seedWorkingMail } from "../helpers/db";
import { seedParentSettings } from "../helpers/roster-cache";

const IP = "203.0.113.30";
const staff = { actor: { door: "staff" as const, id: null, label: "board" }, ip: null };
/** What the reconcile does when a family is no longer in the roster: the row is disabled, and the sessions end if it was the last. */
async function dropRow(guardianId: string) {
  const [row] = await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, guardianId)).returning();
  if ((await enabledGuardianRows(row!.parentId)).length === 0) await endParentSessions(row!.parentId);
}
async function post(path: string, body: unknown, cookie?: string) {
  const auth = await getParentAuth();
  return auth.handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: env.APP_URL, "cf-connecting-ip": IP, ...(cookie ? { cookie } : {}) },
  }));
}
const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
async function getSession(cookie: string) {
  const auth = await getParentAuth();
  const res = await auth.handler(new Request(`${env.APP_URL}/api/auth/parent/get-session`, { headers: { cookie, origin: env.APP_URL } }));
  return (await res.json()) as { session: { id: string; userId: string; familyQboId?: string | null; expiresAt: string } } | null;
}
async function signIn(email: string, extra: Record<string, unknown> = {}) {
  const sent = outbox.length;
  await post("/portal-code/send", { email });
  await vi.waitFor(() => expect(outbox.length).toBeGreaterThan(sent));
  const code = /sign-in code: (\d{6})/.exec(outbox.at(-1)!.subject)![1]!;
  const res = await post("/portal-code/verify", { email, code, ...extra });
  return { res, body: (await res.json()) as { ok: boolean; next?: string; error?: string }, cookie: cookieFrom(res) };
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
  return resolveParentSession({ id: s.session.id, userId: s.session.userId, familyQboId: s.session.familyQboId ?? null });
};

describe("the parent door", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("answers the same for known, unknown, blocked and all-disabled, and only the known one gets mail", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const b = await seedParent({ name: "Ben", email: "ben@example.com", blocked: true }); await seedGuardian({ parentId: b.id, familyQboId: "F1" });
    const c = await seedParent({ name: "Cy", email: "cy@example.com" }); await seedGuardian({ parentId: c.id, familyQboId: "F1", status: "disabled", disabledReason: "removed" });
    const answers = [];
    for (const email of ["ana@example.com", "nobody@example.com", "ben@example.com", "cy@example.com"]) {
      const res = await post("/portal-code/send", { email });
      answers.push([res.status, await res.text()]);
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0]).toEqual([200, JSON.stringify({ ok: true })]);
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    expect(outbox[0]!.to).toBe("ana@example.com");
  });

  it("a code check answers the same for an unknown email and a wrong code", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    await post("/portal-code/send", { email: "ana@example.com" });
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    const code = /sign-in code: (\d{6})/.exec(outbox[0]!.subject)![1]!;
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const r1 = await post("/portal-code/verify", { email: "ana@example.com", code: wrong });
    const r2 = await post("/portal-code/verify", { email: "nobody@example.com", code: wrong });
    expect([r1.status, await r1.text()]).toEqual([r2.status, await r2.text()]);
    expect(r1.headers.getSetCookie().some((c) => c.startsWith("br_parent.session_token"))).toBe(false);
  });

  it("with one family, goes straight in, activates invited rows and audits the sign-in with the family", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const { body, cookie } = await signIn("ana@example.com");
    expect(body).toEqual({ ok: true, next: "/" });
    const state = await stateOf(cookie);
    expect(state).toMatchObject({ status: "ok", identity: { parentId: a.id, familyQboId: "F1", guardianId: g.id, families: [{ familyQboId: "F1" }] } });
    expect((await db.select().from(guardian))[0]!.status).toBe("active");
    const rows = await db.select().from(auditLog);
    expect(rows.filter((x) => x.action === "guardian.activate")).toHaveLength(1);
    expect(rows.find((x) => x.action === "signin")).toMatchObject({ door: "parent", actorId: a.id, targetType: "parent", targetId: a.id, after: { familyQboId: "F1" }, ip: IP });
  });

  it("activates every invited link at once, audits each, and leaves a closed link closed", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const one = await seedGuardian({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const two = await seedGuardian({ parentId: a.id, familyQboId: "F2", status: "invited" });
    const shut = await seedGuardian({ parentId: a.id, familyQboId: "F3", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
    expect(await completeParentSignin(a.id, IP)).toEqual({ familyQboId: null });                // two families: the parent chooses
    const status = Object.fromEntries((await db.select().from(guardian)).map((g) => [g.id, g.status]));
    expect(status).toEqual({ [one.id]: "active", [two.id]: "active", [shut.id]: "disabled" });
    const activated = (await db.select().from(auditLog)).filter((x) => x.action === "guardian.activate");
    expect(activated.map((x) => x.targetId).sort()).toEqual([one.id, two.id].sort());
    for (const row of activated) expect(row).toMatchObject({ door: "parent", actorId: a.id, before: { status: "invited" }, after: { status: "active" }, ip: IP });
    expect((await db.select().from(auditLog)).some((x) => x.action === "signin")).toBe(false);
  });

  it("activates nothing and records no sign-in for a session that was ended while it was being made", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const live = await seedParentSession(a.authUserId);
    await endParentSessions(a.id);                                       // a block or a change of address got there first
    expect(await completeParentSignin(a.id, IP, live.id)).toEqual({ familyQboId: null, sessionEnded: true });
    expect((await db.select().from(guardian))[0]).toMatchObject({ id: g.id, status: "invited" });
    expect(await db.select().from(auditLog)).toEqual([]);
    // The session that is still there is entered into the one family, and audited.
    const kept = await seedParentSession(a.authUserId);
    expect(await completeParentSignin(a.id, IP, kept.id)).toEqual({ familyQboId: "F1" });
    expect((await db.select().from(parentAuthSession))[0]).toMatchObject({ id: kept.id, familyQboId: "F1" });
    expect((await db.select().from(auditLog)).map((x) => x.action)).toEqual(["guardian.activate", "signin"]);
  });

  it("signs a parent out on their next request when an Admin switched sign-ins off after they got in", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    expect(await stateOf(cookie)).toMatchObject({ status: "ok" });
    await seedParentSettings({ signin: false, everEnabled: true });
    expect(await stateOf(cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await db.select().from(auditLog)).filter((x) => x.action === "signin.refused").at(-1)).toMatchObject({
      door: "parent", actorId: a.id, targetType: "parent", targetId: a.id, after: { reason: "signins_off" } });
  });

  it("with two families, asks first; choosing audits the sign-in, choosing again audits a switch", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1" }); await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    const { body, cookie } = await signIn("ana@example.com");
    expect(body).toEqual({ ok: true, next: "/choose-family" });
    const first = await stateOf(cookie);
    expect(first).toMatchObject({ status: "choose", families: [{ familyQboId: "F1" }, { familyQboId: "F2" }] });
    const sessionId = first.status === "choose" ? first.sessionId : "";
    expect(await chooseFamily({ sessionId, parentId: a.id, familyQboId: "F2", ip: IP })).toBe(true);
    expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { familyQboId: "F2" } });
    expect(await chooseFamily({ sessionId, parentId: a.id, familyQboId: "F1", ip: IP })).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows.filter((x) => x.action === "signin").map((x) => x.after)).toEqual([{ familyQboId: "F2" }]);
    expect(rows.find((x) => x.action === "signin.family_switch")!.after).toEqual({ from: "F2", to: "F1" });
    expect(await chooseFamily({ sessionId, parentId: a.id, familyQboId: "F9", ip: IP })).toBe(false);
  });

  it("sends a parent back to choose when the chosen family goes away and another is left", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g1 = await seedGuardian({ parentId: a.id, familyQboId: "F1" }); await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    const { cookie } = await signIn("ana@example.com");
    const s = await stateOf(cookie);
    await chooseFamily({ sessionId: s.status === "choose" ? s.sessionId : "", parentId: a.id, familyQboId: "F1", ip: IP });
    await dropRow(g1.id);
    expect(await stateOf(cookie)).toMatchObject({ status: "choose", families: [{ familyQboId: "F2" }] });
    expect((await db.select().from(parentAuthSession))[0]!.familyQboId).toBeNull();
    expect((await db.select().from(auditLog)).find((x) => x.action === "signin.refused")!.after).toEqual({ reason: "family_not_enabled", familyQboId: "F1" });
  });

  it("signs a parent out at once when their last family goes, or they're blocked", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const one = await signIn("ana@example.com");
    await dropRow(g.id);
    expect(await getSession(one.cookie)).toBeNull();
    const b = await seedParent({ name: "Ben", email: "ben@example.com" }); await seedGuardian({ parentId: b.id, familyQboId: "F2" });
    outbox.length = 0;
    const two = await signIn("ben@example.com");
    await blockPerson(b.id, "reason", staff);
    expect(await getSession(two.cookie)).toBeNull();
  });

  it("lasts 90 days from sign-in, with a cookie that outlives it", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
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
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
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
    expect(renewed).toMatchObject({ id: made.id, token: made.token, familyQboId: "F1" });
    // And the next use that day leaves it alone again.
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok" });
    expect(await sessionRow()).toEqual(renewed);
  });

  it("is renewed for a parent who has yet to choose a family, too", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1" }); await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    const { cookie } = await signIn("ana@example.com");
    await timePasses(3 * DAY);
    expect(await pageRequest(cookie)).toMatchObject({ status: "choose" });
    near((await sessionRow()).expiresAt.getTime(), Date.now() + 90 * DAY);
  });

  it("still takes the same cookie after the first 90 days, when use has kept the session going", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    // Day 80: used, so the session now ends on day 170.
    await timePasses(80 * DAY);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok", identity: { parentId: a.id } });
    // Day 150: 60 days past the end it was given at sign-in. The cookie from sign-in is still the one presented.
    await timePasses(70 * DAY);
    near(Date.now() - (await sessionRow()).createdAt.getTime(), 150 * DAY);
    expect(await pageRequest(cookie)).toMatchObject({ status: "ok", identity: { parentId: a.id, familyQboId: "F1" } });
    near((await sessionRow()).expiresAt.getTime(), Date.now() + 90 * DAY);
  });

  it("refuses and removes a session that was not used for 90 days", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
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
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    await signIn("ana@example.com");
    await timePasses(90 * DAY + 1000);
    const row = await sessionRow();
    expect(await renewParentSession({ id: row.id, expiresAt: row.expiresAt })).toBe(false);
    // Even told the session was live a moment ago, the update only matches a row that still is.
    expect(await renewParentSession({ id: row.id, expiresAt: new Date(Date.now() + DAY) })).toBe(false);
    expect((await sessionRow()).expiresAt).toEqual(row.expiresAt);
  });

  it("is not renewed for a session the portal refuses", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    await timePasses(3 * DAY);
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.id));
    expect(await pageRequest(cookie)).toEqual({ status: "none" });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
  });

  it("is neither renewed nor given a new cookie by Better Auth's own get-session", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
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
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    expect((await signIn("ana@example.com", { next: "/display" })).body).toEqual({ ok: true, next: "/display" });
    const b = await seedParent({ name: "Ben", email: "ben@example.com" }); await seedGuardian({ parentId: b.id, familyQboId: "F1" });
    expect((await signIn("ben@example.com", { next: "//evil.example/display" })).body).toEqual({ ok: true, next: "/" });
    const c = await seedParent({ name: "Cy", email: "cy@example.com" }); await seedGuardian({ parentId: c.id, familyQboId: "F1" });
    expect((await signIn("cy@example.com", { next: "/staff/roster" })).body).toEqual({ ok: true, next: "/" });
    // With two families the chooser comes first, and carries the page with it.
    const d = await seedParent({ name: "Di", email: "di@example.com" });
    await seedGuardian({ parentId: d.id, familyQboId: "F1" }); await seedGuardian({ parentId: d.id, familyQboId: "F2" });
    expect((await signIn("di@example.com", { next: "/display" })).body).toEqual({ ok: true, next: "/choose-family?next=%2Fdisplay" });
    const e = await seedParent({ name: "Ed", email: "ed@example.com" });
    await seedGuardian({ parentId: e.id, familyQboId: "F1" }); await seedGuardian({ parentId: e.id, familyQboId: "F2" });
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
    // In front of the database limits, an in-memory cap per IP on the two code routes (on when NODE_ENV is production).
    // A minute of it allows what the database allows in 15, so it is never the first limit a full room meets.
    expect(o.rateLimit?.customRules).toEqual({ "/portal-code/send": { window: 60, max: 60 }, "/portal-code/verify": { window: 60, max: 180 } });
    expect((o.rateLimit as { enabled?: boolean } | undefined)?.enabled).toBeUndefined(); // Better Auth's default: on only in production
  });

  it("over the check limit, says so", async () => {
    for (let i = 0; i < 180; i++) await post("/portal-code/verify", { email: `n${i}@example.com`, code: "123456" });
    const res = await post("/portal-code/verify", { email: "n@example.com", code: "123456" });
    expect(await res.json()).toEqual({ ok: false, error: "rate_limited" });
  }, 60_000);

  it("answers not found, and changes nothing, on every Better Auth endpoint a parent could write through", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const auth = await getParentAuth();
    const call = (path: string, method: "GET" | "POST", body: unknown = {}) => auth.handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
      method, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      headers: { "content-type": "application/json", origin: env.APP_URL, "cf-connecting-ip": IP, cookie },
    }));
    const writes: [string, "GET" | "POST", unknown][] = [
      ["/update-user", "POST", { name: "Mallory", image: "https://evil.example/x.png" }],
      ["/update-session", "POST", { familyQboId: "F9" }],
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
    expect(await getSession(cookie)).toMatchObject({ session: { familyQboId: "F1" } });
    expect((await post("/sign-out", {}, cookie)).status).toBe(200);
    expect((await db.select().from(auditLog)).filter((x) => x.action === "signout")).toHaveLength(1);
  }, 30_000);

  it("leaves a parent only the endpoints the portal uses", async () => {
    const auth = await getParentAuth();
    const reachable = ["/get-session", "/sign-out", "/portal-code/send", "/portal-code/verify", "/ok", "/error"];
    // Path-parameter routes can't be listed in disabledPaths (it matches exact paths). Neither can do anything here:
    // there are no social providers to call back to, and there's no password to reset.
    const parameterized = ["/callback/:id", "/reset-password/:token"];
    const paths = Object.values(auth.api).map((e) => (e as { path?: string }).path).filter((p): p is string => !!p);
    const disabled = new Set(auth.options.disabledPaths ?? []);
    expect(paths.filter((p) => !disabled.has(p)).sort()).toEqual([...reachable, ...parameterized].sort());
  });

  it("records a sign-out through /sign-out against the person", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const res = await post("/sign-out", {}, cookie);
    expect(res.status).toBe(200);
    expect((await db.select().from(auditLog)).find((x) => x.action === "signout")).toMatchObject({ door: "parent", actorId: a.id, actorLabel: "ana@example.com", targetType: "parent", targetId: a.id, ip: IP });
    expect(await db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, a.authUserId))).toHaveLength(0);
  });
});
