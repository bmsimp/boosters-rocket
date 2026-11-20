import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// The breach service is a stub listening on port 0 that has seen no password: the endpoint module is the one place its address lives.
const where = vi.hoisted(() => ({ range: "" }));
vi.mock("@/lib/parents/breach-endpoints", () => ({ breachEndpoints: () => ({ range: where.range }) }));
// The request a page or an action is run for, with what an action sets through cookies() recorded: everything that
// reads it is real (the session read, the gate, the renewal).
import { cookieFromActions, cookiesSetByActions, fromBrowser } from "../helpers/page-request";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, parent, parentAuthSession, parentSigninToken } from "@/lib/db/schema";
import { getParentState } from "@/lib/auth/identity";
import { signInFromLink } from "@/lib/auth/parent-link-signin";
import { choosePasswordFromLink, type LinkSignin } from "@/lib/parents/password-set";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { blockPerson } from "@/lib/parents/people";
import { PARENT_SESSION_COOKIE_SECONDS } from "@/lib/parents/sessions";
import { signinStands } from "@/lib/parents/signin-codes";
import { choosePasswordAction } from "@/app/sign-in/password-actions";
import { resetDb, seedGuardianInFamily, seedParent, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { deviceRows, mintLink, seedDevice, seedPassword } from "../helpers/signin-links";
import { signInThroughDoor } from "../helpers/parent-door";
import { hashDeviceToken } from "@/lib/parents/devices";

/**
 * A set-up link signs the parent in (the sign-in release, slice SI-3a): once its password is set while the club's level
 * is Standard, through the one finish every sign-in goes through (src/lib/auth/parent-signin-finish.ts), with the cookie
 * the door sets. Since slice SI-3b it also remembers the device it was used on and marks the session strong, since the
 * link proved the mailbox and its form set the password. Under Strict, and for a reset, nobody is signed in.
 */
const IP = "203.0.113.30";
const GOOD = "correct horse battery staple, the club's own";
const OTHER = "a second phrase that is long enough too";
const staff = { actor: { door: "staff" as const, id: null, label: "board" }, ip: null };
const REFUSED = { ok: false, errors: [PASSWORD_COPY.linkNoGood] };
const choose = (token: string, purpose: "setup" | "reset" = "setup", password = GOOD) => choosePasswordAction(purpose, token, password, password);
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const sessions = () => db.select().from(parentAuthSession);
const sessionCookies = () => cookiesSetByActions().filter((c) => c.name.startsWith("br_parent") && c.name.endsWith(".session_token"));
const deviceCookies = () => cookiesSetByActions().filter((c) => c.name.startsWith("br_parent") && c.name.endsWith(".device"));

let server: Server;
beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }).end(`${"0".repeat(35)}:0`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  where.range = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

/** Ana, invited to one family (or two) of the app's own, with a sign-in account and no password; sign-ins are on. */
async function seedAna(o: { families?: 1 | 2; level?: "standard" | "strict" } = {}) {
  await seedParentSettings({ ...SIGNINS_ON, level: o.level ?? "standard" });
  const ana = await seedParent({ name: "Ana Zebrafish", email: "ana@example.com" });
  const rows = [await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1", status: "invited" })];
  if (o.families === 2) rows.push(await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F2", status: "invited" }));
  return { ana, rows };
}

/** The set's own work alone, with the sign-in it hands back: what the action finishes. */
async function setWithProof(token: string): Promise<LinkSignin> {
  const r = await choosePasswordFromLink({ purpose: "setup", token, password: GOOD, again: GOOD }, { ip: IP });
  if (!r.ok || !r.signIn) expect.fail(`the set gave no sign-in: ${JSON.stringify(r)}`);
  return r.signIn;
}

describe("a set-up link signs the parent in", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; });

  it("at Standard, with one family: lands on /, the cookie reads back as the person's session, invited rows go active and the sign-in is audited", async () => {
    const { ana, rows: [row] } = await seedAna();
    expect(await choose(await mintLink(ana.id, "setup"))).toEqual({ ok: true, message: PASSWORD_COPY.signingIn, next: "/" });
    expect(await sessions()).toHaveLength(1);
    expect(await sessions()).toEqual([expect.objectContaining({ familyId: row!.familyId, ipAddress: IP })]);

    fromBrowser(cookieFromActions());
    const state = await getParentState();
    expect(state).toMatchObject({ status: "ok", identity: { parentId: ana.id, familyId: row!.familyId, guardianId: row!.id } });
    expect((await db.select().from(guardian))[0]!.status).toBe("active");
    expect(await audits("guardian.activate")).toHaveLength(1);
    const [signin] = await audits("signin");
    expect(signin).toMatchObject({ door: "parent", actorId: ana.id, targetType: "parent", targetId: ana.id, after: { familyId: String(row!.familyId) }, ip: IP });
    // The proof the set made never reaches an audit row.
    const link = (await db.select().from(parentSigninToken))[0]!;
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(link.id);
  });

  it("with two families: lands on the chooser, still choosing", async () => {
    const { ana } = await seedAna({ families: 2 });
    expect(await choose(await mintLink(ana.id, "setup"))).toEqual({ ok: true, message: PASSWORD_COPY.signingIn, next: "/choose-family" });
    fromBrowser(cookieFromActions());
    expect(await getParentState()).toMatchObject({ status: "choose", parentId: ana.id });
    expect(await sessions()).toEqual([expect.objectContaining({ familyId: null })]);
    expect(await audits("signin")).toEqual([]);
  });

  it("sets the cookie the code door sets: the same name, life and attributes", async () => {
    await seedWorkingMail();
    const { ana } = await seedAna();
    await choose(await mintLink(ana.id, "setup"));
    const [mine] = sessionCookies();
    expect(sessionCookies()).toHaveLength(1);
    expect(mine!.options).toMatchObject({ maxAge: PARENT_SESSION_COOKIE_SECONDS, path: "/", httpOnly: true, sameSite: "lax" });

    // Ben signs in by password and code at the door itself; his cookies are the ones to match.
    const ben = await seedParent({ name: "Ben", email: "ben@example.com" });
    await seedGuardianInFamily({ parentId: ben.id, familyQboId: "F9" });
    const { res } = await signInThroughDoor(outbox, "ben@example.com", { headers: { "cf-connecting-ip": IP } });
    const [myDevice] = deviceCookies();
    expect(deviceCookies()).toHaveLength(1);
    for (const copied of [mine!, myDevice!]) {
      const door = res.headers.getSetCookie().find((c) => c.startsWith(`${copied.name}=`))!;
      const attrs = new Map(door.split(";").slice(1).map((a) => a.trim().split("=")).map(([k, v]): [string, string | true] => [k!.toLowerCase(), v ?? true]));
      expect(Number(attrs.get("max-age"))).toBe(copied.options.maxAge);
      expect(attrs.get("path")).toBe(copied.options.path);
      expect(attrs.get("httponly")).toBe(true);
      expect(String(attrs.get("samesite")).toLowerCase()).toBe(copied.options.sameSite);
      expect(attrs.has("secure")).toBe(copied.options.secure === true);
    }
  });

  it("remembers the device it was used on: one device row, its cookie copied onto the answer, and the session marked strong", async () => {
    const { ana } = await seedAna();
    const before = Date.now();
    expect(await choose(await mintLink(ana.id, "setup"))).toEqual({ ok: true, message: PASSWORD_COPY.signingIn, next: "/" });
    const rows = await deviceRows(ana.id);
    expect(rows).toHaveLength(1);
    const [cookie] = deviceCookies();
    expect(deviceCookies()).toHaveLength(1);
    // The cookie holds the token; the row only its keyed hash; neither is in any audit row.
    expect(hashDeviceToken(cookie!.value)).toBe(rows[0]!.tokenHash);
    // The row is the authority and is renewed by use (slice SI-5b), so the cookie gets the longest life browsers allow.
    expect(cookie!.options).toMatchObject({ path: "/api/auth/parent", httpOnly: true, sameSite: "lax", maxAge: PARENT_SESSION_COOKIE_SECONDS });
    const all = JSON.stringify(await db.select().from(auditLog));
    expect(all).not.toContain(cookie!.value);
    expect(all).not.toContain(rows[0]!.tokenHash);
    expect(await audits("signin.device_remembered")).toEqual([expect.objectContaining({ actorId: ana.id, targetId: ana.id, after: expect.objectContaining({ deviceId: rows[0]!.id }) })]);
    const [session] = await sessions();
    expect(session!.strongAt).not.toBeNull();
    expect(session!.strongAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The session names the device it was made on (slice SI-5b), so its renewal renews that device.
    expect(session!.deviceId).toBe(rows[0]!.id);
    // No pending step was held, so none is cleared.
    expect(cookiesSetByActions().filter((c) => c.name.endsWith(".signin_step"))).toEqual([]);
  });

  it("at Strict, the password is set and nobody is signed in", async () => {
    const { ana } = await seedAna({ level: "strict" });
    expect(await choose(await mintLink(ana.id, "setup"))).toEqual({ ok: true, message: PASSWORD_COPY.set });
    expect(await sessions()).toEqual([]);
    expect(sessionCookies()).toEqual([]);
    expect((await db.select().from(guardian))[0]!.status).toBe("invited");
  });

  it("a reset signs nobody in, at Standard too, remembers no device and forgets every one", async () => {
    const { ana } = await seedAna();
    await seedPassword(ana.authUserId, OTHER);
    await seedDevice(ana.id); await seedDevice(ana.id);
    expect(await choose(await mintLink(ana.id, "reset"), "reset")).toEqual({ ok: true, message: PASSWORD_COPY.set });
    expect(await sessions()).toEqual([]);
    expect(sessionCookies()).toEqual([]);
    expect(deviceCookies()).toEqual([]);
    expect(await deviceRows(ana.id)).toEqual([]);
  });

  it("two submits of one set-up link at once make at most one session", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    const results = await Promise.all([choose(token), choose(token, "setup", OTHER)]);
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, message: PASSWORD_COPY.signingIn, next: "/" }]);
    expect(results.filter((r) => !r.ok)).toEqual([REFUSED]);
    expect(await sessions()).toHaveLength(1);
    expect(sessionCookies()).toHaveLength(1);
  }, 30_000);
});

describe("a set-up link's sign-in is refused when something changed since the set", () => {
  beforeEach(async () => { await resetDb(); });

  it("signinStands() takes a link's proof: it stands as set, and not after a block, a change of address, a reset or the link gone", async () => {
    const { ana } = await seedAna();
    const s = await setWithProof(await mintLink(ana.id, "setup"));
    expect(await signinStands(ana.id, s.email, IP, { link: s.proof })).toBe(true);
    const reasons = async () => (await audits("signin.refused")).map((r) => (r.after as { reason: string }).reason);

    // A reset made since replaces the password row's write: the proof no longer matches.
    await choose(await mintLink(ana.id, "reset"), "reset", OTHER);
    expect(await signinStands(ana.id, s.email, IP, { link: s.proof })).toBe(false);
    expect(await reasons()).toEqual(["password_changed"]);

    await resetDb();
    const b = await seedAna();
    const sb = await setWithProof(await mintLink(b.ana.id, "setup"));
    await db.update(parent).set({ email: "ana.new@example.com" }).where(eq(parent.id, b.ana.id));
    expect(await signinStands(b.ana.id, sb.email, IP, { link: sb.proof })).toBe(false);
    expect(await reasons()).toEqual(["address_changed"]);

    await resetDb();
    const c = await seedAna();
    const sc = await setWithProof(await mintLink(c.ana.id, "setup"));
    await blockPerson(c.ana.id, "reason", staff);
    expect(await signinStands(c.ana.id, sc.email, IP, { link: sc.proof })).toBe(false);
    expect(await reasons()).toEqual(["blocked"]);

    await resetDb();
    const d = await seedAna();
    const sd = await setWithProof(await mintLink(d.ana.id, "setup"));
    await db.delete(parentSigninToken);
    expect(await signinStands(d.ana.id, sd.email, IP, { link: sd.proof })).toBe(false);
    expect(await reasons()).toEqual(["link_gone"]);
  });

  it("a person left with no row that counts by the finish is refused, with no session and no cookie", async () => {
    const { ana, rows: [row] } = await seedAna();
    const s = await setWithProof(await mintLink(ana.id, "setup"));
    await db.update(family).set({ active: false }).where(eq(family.id, row!.familyId!));
    expect(await signInFromLink(s)).toBeNull();
    expect(await sessions()).toEqual([]);
    expect(sessionCookies()).toEqual([]);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "no_enabled_guardian" }]);
    expect(await audits("signin")).toEqual([]);
  });

  it("a block between the set and the finish: the action answers that the password is set, with no session and no cookie", async () => {
    const { ana } = await seedAna();
    const s = await setWithProof(await mintLink(ana.id, "setup"));
    await blockPerson(ana.id, "reason", staff);
    expect(await signInFromLink(s)).toBeNull();
    expect(await sessions()).toEqual([]);
    expect(sessionCookies()).toEqual([]);
  });
});
