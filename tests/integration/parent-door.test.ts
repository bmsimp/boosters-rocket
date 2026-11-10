import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parentAuthSession, parentAuthUser } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { resolveParentSession } from "@/lib/auth/resolve";
import { chooseFamily } from "@/lib/parents/family-choice";
import { removeGuardian, blockPerson } from "@/lib/parents/people";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardian, seedWorkingMail } from "../helpers/db";

const IP = "203.0.113.30";
const staff = { actor: { door: "staff" as const, id: null, label: "board" }, ip: null };
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
async function signIn(email: string) {
  await post("/portal-code/send", { email });
  await vi.waitFor(() => expect(outbox.length).toBeGreaterThan(0));
  const code = /sign-in code: (\d{6})/.exec(outbox.at(-1)!.subject)![1]!;
  const res = await post("/portal-code/verify", { email, code });
  return { res, body: (await res.json()) as { ok: boolean; next?: string; error?: string }, cookie: cookieFrom(res) };
}
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
    await removeGuardian(g1.id, staff);
    expect(await stateOf(cookie)).toMatchObject({ status: "choose", families: [{ familyQboId: "F2" }] });
    expect((await db.select().from(parentAuthSession))[0]!.familyQboId).toBeNull();
    expect((await db.select().from(auditLog)).find((x) => x.action === "signin.refused")!.after).toEqual({ reason: "family_not_enabled", familyQboId: "F1" });
  });

  it("signs a parent out at once when their last family goes, or they're blocked", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const one = await signIn("ana@example.com");
    await removeGuardian(g.id, staff);
    expect(await getSession(one.cookie)).toBeNull();
    const b = await seedParent({ name: "Ben", email: "ben@example.com" }); await seedGuardian({ parentId: b.id, familyQboId: "F2" });
    outbox.length = 0;
    const two = await signIn("ben@example.com");
    await blockPerson(b.id, staff);
    expect(await getSession(two.cookie)).toBeNull();
  });

  it("lasts 7 days from sign-in and isn't extended by use", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const [row] = await db.select().from(parentAuthSession);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThan(7 * 86_400_000 - 5_000);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeLessThan(7 * 86_400_000 + 5_000);
    // Pretend the session was made 3 days ago and used since: get-session must not push the expiry out.
    const back = (d: Date) => new Date(d.getTime() - 3 * 86_400_000);
    await db.update(parentAuthSession).set({ createdAt: back(row!.createdAt), updatedAt: back(row!.updatedAt), expiresAt: back(row!.expiresAt) });
    expect(await getSession(cookie)).not.toBeNull();
    const [after] = await db.select().from(parentAuthSession);
    expect(after!.expiresAt.getTime()).toBe(back(row!.expiresAt).getTime());
    await db.update(parentAuthSession).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getSession(cookie)).toBeNull();
  });

  it("is configured so a session is read from the database on every request and never refreshed", async () => {
    const o = (await getParentAuth()).options;
    expect(o.session?.disableSessionRefresh).toBe(true);
    expect(o.session?.expiresIn).toBe(7 * 24 * 60 * 60);
    // Not declared at all in our config, so the type has no such key; read it loosely.
    expect((o.session as { cookieCache?: { enabled?: boolean } } | undefined)?.cookieCache?.enabled ?? false).toBe(false);
    expect(o.advanced?.ipAddress?.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
    expect(o.emailAndPassword?.enabled).toBe(false);
  });

  it("over the check limit, says so", async () => {
    for (let i = 0; i < 30; i++) await post("/portal-code/verify", { email: `n${i}@example.com`, code: "123456" });
    const res = await post("/portal-code/verify", { email: "n@example.com", code: "123456" });
    expect(await res.json()).toEqual({ ok: false, error: "rate_limited" });
  });

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
    const [u] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, a.authUserId));
    expect(u).toMatchObject({ name: "Ana", image: null, email: "ana@example.com" });
    expect(await db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, a.authUserId))).toHaveLength(1);
    expect(await getSession(cookie)).toMatchObject({ session: { familyQboId: "F1" } });
    expect((await post("/sign-out", {}, cookie)).status).toBe(200);
    expect((await db.select().from(auditLog)).filter((x) => x.action === "signout")).toHaveLength(1);
  });

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
