import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// The real session read, with only the request made up.
import { fromBrowser } from "../helpers/page-request";

import { createHmac } from "node:crypto";
import { getIP } from "better-auth/api";
import { db } from "@/lib/db/client";
import { withClientIp } from "@/lib/request";
import { clientAddress } from "@/lib/auth/client-address";
import { requestSigninCode, verifySigninCode } from "@/lib/parents/signin-codes";
import { RATE_LIMITS } from "@/lib/parents/rate-limit";
import { auditLog, parentAuthSession, rateLimitEvent, staffAuthSession, staffAuthUser } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { getStaffAuth } from "@/lib/auth/staff-auth";
import { getParentState } from "@/lib/auth/identity";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardianInFamily, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";

/**
 * The address a request came from is read in one place (src/lib/request.ts) from the header the deployment names
 * (CLIENT_IP_HEADER), and the audit log, the sign-in limits and both Better Auth set-ups all take it from there.
 * These tests send a request that carries a true address in the trusted header and a different lie in every other
 * header that could name one, then look at everything the portal stored.
 */
const TRUE = "203.0.113.77";
const LIES = { "x-booster-client-ip": "6.6.6.1", "x-real-ip": "6.6.6.2", forwarded: "for=6.6.6.3", "x-client-ip": "6.6.6.4", "true-client-ip": "6.6.6.5" };

async function post(path: string, body: unknown, headers: Record<string, string>, cookie?: string) {
  const auth = await getParentAuth();
  return auth.handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: env.APP_URL, ...headers, ...(cookie ? { cookie } : {}) },
  }));
}
const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
async function signIn(email: string, headers: Record<string, string>) {
  const sent = outbox.length;
  await post("/portal-code/send", { email }, headers);
  await vi.waitFor(() => expect(outbox.length).toBeGreaterThan(sent));
  const code = /sign-in code: (\d{6})/.exec(outbox.at(-1)!.subject)![1]!;
  const res = await post("/portal-code/verify", { email, code }, headers);
  expect(await res.json()).toMatchObject({ ok: true });
  return cookieFrom(res);
}
/** Every address the portal wrote down, wherever it wrote one. */
async function addressesStored() {
  const [audit, limits, parentSessions, staffSessions] = await Promise.all([
    db.select({ ip: auditLog.ip, action: auditLog.action }).from(auditLog),
    db.select({ subject: rateLimitEvent.subject, kind: rateLimitEvent.kind }).from(rateLimitEvent),
    db.select({ ip: parentAuthSession.ipAddress }).from(parentAuthSession),
    db.select({ ip: staffAuthSession.ipAddress }).from(staffAuthSession),
  ]);
  return {
    audit: audit.map((r) => r.ip), auditActions: audit.map((r) => r.action),
    limits: limits.filter((r) => r.kind.endsWith("_ip")).map((r) => r.subject),
    sessions: [...parentSessions, ...staffSessions].map((r) => r.ip),
  };
}

describe("the address a client comes from", () => {
  const setting = env.CLIENT_IP_HEADER;
  beforeEach(async () => {
    await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON);
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1" });
  });
  afterEach(() => { env.CLIENT_IP_HEADER = setting; });

  it("is Cloudflare's header by default, for the audit log, the sign-in limits and the session alike", async () => {
    await signIn("ana@example.com", { "cf-connecting-ip": TRUE, "x-forwarded-for": "6.6.6.6, 6.6.6.7", ...LIES });
    const stored = await addressesStored();
    expect(stored.auditActions).toEqual(expect.arrayContaining(["signin.code_sent", "signin"]));
    expect(new Set(stored.audit)).toEqual(new Set([TRUE]));
    expect(new Set(stored.limits)).toEqual(new Set([TRUE]));
    expect(stored.sessions).toEqual([TRUE]);
  });

  it("is the header the deployment names instead, read from the right, and Cloudflare's is then one more thing a client can send", async () => {
    env.CLIENT_IP_HEADER = "x-forwarded-for";
    await signIn("ana@example.com", { "x-forwarded-for": `6.6.6.6, 6.6.6.7, ${TRUE}`, "cf-connecting-ip": "6.6.6.8", ...LIES });
    const stored = await addressesStored();
    expect(new Set(stored.audit)).toEqual(new Set([TRUE]));
    expect(new Set(stored.limits)).toEqual(new Set([TRUE]));
    expect(stored.sessions).toEqual([TRUE]);
  });

  it("is unknown when the trusted header is missing: nothing else the client sends is believed", async () => {
    await signIn("ana@example.com", { "x-forwarded-for": "6.6.6.6", ...LIES });
    const stored = await addressesStored();
    expect(new Set(stored.audit)).toEqual(new Set([null]));
    // No address, no count per address: all visitors would share one (signin-codes.ts).
    expect(stored.limits).toEqual([]);
    // Better Auth writes its own placeholder on a session when it is told no address; never one of the client's.
    expect(JSON.stringify(stored)).not.toContain("6.6.6.");
  });

  it("is unknown when the setting is none, whatever is sent", async () => {
    env.CLIENT_IP_HEADER = "none";
    await signIn("ana@example.com", { "cf-connecting-ip": "6.6.6.8", "x-forwarded-for": "6.6.6.6", none: "6.6.6.9", ...LIES });
    const stored = await addressesStored();
    expect(new Set(stored.audit)).toEqual(new Set([null]));
    expect(stored.limits).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain("6.6.6.");
  });

  it("with no address, one visitor's flood doesn't close the door to every other parent", async () => {
    // Past the per-IP cap, from visitors the portal can't tell apart, for addresses that aren't on file.
    for (let i = 0; i <= RATE_LIMITS.code_send_ip.max; i++) await requestSigninCode(`nobody${i}@example.com`, null);
    for (let i = 0; i <= RATE_LIMITS.code_check_ip.max; i++) await verifySigninCode(`nobody${i % 50}@example.com`, "000000", null);
    const sent = outbox.length;
    await (await requestSigninCode("ana@example.com", null)).delivery;
    expect(outbox.length).toBe(sent + 1);
    const code = /sign-in code: (\d{6})/.exec(outbox.at(-1)!.subject)![1]!;
    expect(await verifySigninCode("ana@example.com", code, null)).toMatchObject({ ok: true });
    expect((await db.select().from(auditLog)).filter((r) => r.action === "signin.code_refused").map((r) => (r.after as { reason?: string }).reason))
      .not.toContain("rate_limited");
  }, 60_000);

  it("with the setting none, Better Auth is told there is no address, so its limiter doesn't put everyone in one bucket", () => {
    env.CLIENT_IP_HEADER = "none";
    const options = { advanced: { ipAddress: clientAddress() } };
    expect(options.advanced.ipAddress).toMatchObject({ disableIpTracking: true });
    expect(getIP(withClientIp(new Request(`${env.APP_URL}/api/auth/staff/sign-in/social`, { headers: { "cf-connecting-ip": TRUE } })), options)).toBeNull();
    env.CLIENT_IP_HEADER = "cf-connecting-ip";
    expect(clientAddress()).not.toHaveProperty("disableIpTracking");
  });

  it("can't be forged in a page request either: a refusal is audited with the trusted header's address", async () => {
    const cookie = await signIn("ana@example.com", { "cf-connecting-ip": TRUE });
    await db.delete(auditLog);
    // The family link goes while the session lives; the next page request refuses the session and audits it.
    await db.execute("update guardian set status = 'disabled', disabled_reason = 'removed'" as never);
    fromBrowser(cookie, TRUE);
    expect((await getParentState()).status).toBe("none");
    const rows = await db.select({ ip: auditLog.ip }).from(auditLog);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.ip))).toEqual(new Set([TRUE]));
  });

  it("reaches the staff door the same way", async () => {
    await db.insert(staffAuthUser).values({ id: "s1", name: "Sam", email: "sam@club.org", emailVerified: true });
    const auth = await getStaffAuth();
    const ctx = await auth.$context;
    // What Better Auth itself makes of a request (its rate limiter and the address it stores on a session), once the
    // portal has stamped it, and what it makes of the same lies with no trusted header beside them.
    const request = (headers: Record<string, string>) => new Request(`${env.APP_URL}/api/auth/staff/get-session`, { headers });
    expect(getIP(withClientIp(request({ "cf-connecting-ip": TRUE, ...LIES })), auth.options)).toBe(TRUE);
    expect(Object.values(LIES)).not.toContain(getIP(withClientIp(request(LIES)), auth.options));
    expect(getIP(withClientIp(request(LIES)), auth.options) ?? "").not.toContain("6.6.6.");

    // And its handler is the stamping one. A sign-out is audited with the trusted address, or with none.
    const signOut = async (headers: Record<string, string>) => {
      await db.delete(auditLog);
      const made = await ctx.internalAdapter.createSession("s1");
      const sig = createHmac("sha256", env.BETTER_AUTH_SECRET).update(made.token).digest("base64");
      const res = await auth.handler(new Request(`${env.APP_URL}/api/auth/staff/sign-out`, {
        method: "POST", body: "{}",
        headers: { cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${made.token}.${sig}`)}`, origin: env.APP_URL, "content-type": "application/json", ...headers },
      }));
      expect(res.status).toBe(200);
      // (Making the session by hand, outside a request, audits a sign-in with no address; only the sign-out is the handler's.)
      return (await db.select().from(auditLog)).filter((r) => r.action === "signout").map((r) => [r.action, r.ip]);
    };
    expect(await signOut({ "cf-connecting-ip": TRUE, ...LIES })).toEqual([["signout", TRUE]]);
    expect(await signOut({ "x-forwarded-for": "6.6.6.6", ...LIES })).toEqual([["signout", null]]);
  });
});
