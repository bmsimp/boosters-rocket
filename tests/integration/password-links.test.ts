import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { fromIp, renderPage } from "../helpers/signed-in";

// The breach service is a stub listening on port 0: the endpoint module is the one place its address lives.
const where = vi.hoisted(() => ({ range: "" }));
vi.mock("@/lib/parents/breach-endpoints", () => ({ breachEndpoints: () => ({ range: where.range }) }));

import { eq } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, parent, parentAuthAccount, parentAuthSession, parentAuthUser, parentDevice, parentSigninToken, rateLimitEvent, setting, signinCode } from "@/lib/db/schema";
import { hashLinkToken, isLinkToken, LINK_LIFE_MS, linkVerdict, type LinkPurpose } from "@/lib/parents/signin-links";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { RATE_LIMITS, takeRateLimit } from "@/lib/parents/rate-limit";
import { readBreachMark } from "@/lib/parents/breach-mark";
import { CODE_TTL_MS, signinStands, verifySigninCode } from "@/lib/parents/signin-codes";
import { choosePasswordAction } from "@/app/sign-in/password-actions";
import SetUpPage from "@/app/sign-in/set-up/[token]/page";
import ResetPage from "@/app/sign-in/reset/[token]/page";
import { resetDb, seedGuardianInFamily, seedParent, seedParentSession, untilALockIsAwaited } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { credentialRows, linkRows, mintLink, seedCode, seedDevice, seedPassword, unknownToken } from "../helpers/signin-links";

/**
 * The sign-in release's set-up and reset links (slice SI-2): a token minted for a person, stored only as a keyed hash,
 * single use, 7 days for a set-up link and an hour for a reset; the page a link opens, which writes nothing; and its
 * form's action, the portal's one action before sign-in, which sets the password in one transaction with its audit row.
 */
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();
const GOOD = "correct horse battery staple, the club's own";
const OTHER = "a second phrase that is long enough too";
const BREACHED = "password-from-a-breach-1234";

/** How the stub answers: as the service would for a password nobody has seen, for BREACHED as seen, or with a failure. */
let mode: "answer" | "down" = "answer";
/** When set, the stub says it was asked and waits for `until` before it answers: a breach check that is slow. */
let hold: { asked: () => void; until: Promise<void> } | null = null;
let server: Server;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (hold) { hold.asked(); await hold.until; }
    if (mode === "down") { res.writeHead(503).end(); return; }
    const prefix = (req.url ?? "").split("/").pop()!;
    const seen = sha1(BREACHED);
    // A padded range: the breached password's suffix when its prefix is asked for, and a line of padding (count 0) always.
    const lines = [`${"0".repeat(35)}:0`, ...(seen.startsWith(prefix) ? [`${seen.slice(5)}:42`] : [])];
    res.writeHead(200, { "content-type": "text/plain" }).end(lines.join("\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  where.range = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

const IP = "203.0.113.61";
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const choose = (purpose: unknown, token: unknown, password: unknown = GOOD, again: unknown = password) => choosePasswordAction(purpose, token, password, again);
const REFUSED = { ok: false, errors: [PASSWORD_COPY.linkNoGood] };
const page = (purpose: LinkPurpose, token: string) => renderPage(purpose === "setup" ? SetUpPage : ResetPage, { params: { token } });

/** Ana, a guardian of an active family of the app's own, with a sign-in account; sign-ins are on. */
async function seedAna(o: { blocked?: boolean } = {}) {
  await seedParentSettings(SIGNINS_ON);
  const ana = await seedParent({ name: "Ana Zebrafish", email: "ana@example.com", blocked: o.blocked });
  const row = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" });
  await db.update(family).set({ name: "Quokka Family" }).where(eq(family.id, row.familyId!));
  return { ana, row };
}

/** Rows in the tables a page could write to: links, rate-limit counts, audit rows, settings (the breach mark among them). */
async function written() {
  return { links: JSON.stringify(await db.select().from(parentSigninToken)), limits: (await db.select().from(rateLimitEvent)).length,
    audit: (await db.select().from(auditLog)).length, settings: JSON.stringify(await db.select().from(setting).orderBy(setting.key)) };
}

describe("set-up and reset links", () => {
  beforeEach(async () => { await resetDb(); mode = "answer"; fromIp(IP); });

  it("mints a 43-character token, stores only its keyed hash, and never finds a set-up token as a reset token", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    expect(isLinkToken(token)).toBe(true);
    expect(token).toHaveLength(43);
    const [row] = await linkRows(ana.id);
    expect(row).toMatchObject({ purpose: "setup", tokenHash: hashLinkToken("setup", token), usedAt: null });
    expect(JSON.stringify(row)).not.toContain(token);
    // Not a bare hash of the token: keyed with the server secret, and naming the purpose.
    expect(row!.tokenHash).not.toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashLinkToken("reset", token)).not.toBe(row!.tokenHash);
    expect(await linkVerdict("setup", token)).toMatchObject({ ok: true, link: { parentId: ana.id } });
    expect(await linkVerdict("reset", token)).toEqual({ ok: false, reason: "unknown", who: null });
    // Its audit row says what was made, and holds neither the token nor its hash.
    const [made] = await audits("parent.password.link_made");
    expect(made).toMatchObject({ targetType: "parent", targetId: ana.id, after: { purpose: "setup", replaced: 0 } });
    expect(JSON.stringify(made)).not.toContain(token);
    expect(JSON.stringify(made)).not.toContain(row!.tokenHash);
  });

  it("replaces the person's unused link of a purpose, an expired one included, and leaves the other purpose's", async () => {
    const { ana } = await seedAna();
    const first = await mintLink(ana.id, "setup");
    await db.update(parentSigninToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(parentSigninToken.parentId, ana.id));
    const second = await mintLink(ana.id, "setup");
    const reset = await mintLink(ana.id, "reset");
    const rows = await linkRows(ana.id);
    expect(rows.map((r) => r.purpose).sort()).toEqual(["reset", "setup"]);
    expect(rows.find((r) => r.purpose === "setup")!.tokenHash).toBe(hashLinkToken("setup", second));
    expect(await linkVerdict("setup", first)).toMatchObject({ ok: false, reason: "unknown" });
    expect(await linkVerdict("setup", second)).toMatchObject({ ok: true });
    expect(await linkVerdict("reset", reset)).toMatchObject({ ok: true });
    expect((await audits("parent.password.link_made")).map((r) => (r.after as { replaced: number }).replaced)).toEqual([0, 1, 0]);
  });

  it.each(["setup", "reset"] as const)("a %s link works until a second before its life is up, and not a second after", async (purpose) => {
    const { ana } = await seedAna();
    const made = new Date("2026-11-19T12:00:00Z");
    const token = await mintLink(ana.id, purpose, made);
    const at = (ms: number) => new Date(made.getTime() + LINK_LIFE_MS[purpose] + ms);
    expect(LINK_LIFE_MS[purpose]).toBe(purpose === "setup" ? 7 * 86_400_000 : 3_600_000);
    expect(await linkVerdict(purpose, token, { now: at(-1000) })).toMatchObject({ ok: true });
    expect(await linkVerdict(purpose, token, { now: at(0) })).toMatchObject({ ok: false, reason: "expired" });
    expect(await linkVerdict(purpose, token, { now: at(1000) })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("answers a token of any other shape as no link", async () => {
    for (const token of ["", "short", `${unknownToken()}x`, "a".repeat(42) + "=", null, 7, { token: "x" }]) {
      expect(await linkVerdict("setup", token)).toEqual({ ok: false, reason: "unknown", who: null });
    }
  });
});

describe("the page a link opens, and its action, refuse every unusable link alike", () => {
  beforeEach(async () => { await resetDb(); mode = "answer"; fromIp(IP); });

  const otherPurpose = (purpose: LinkPurpose): LinkPurpose => (purpose === "setup" ? "reset" : "setup");
  /**
   * Each way a link of `purpose` can't be used, set up from nothing: the token it gives that purpose's page and action.
   * A set-up link for someone with a password is the set-up page's alone; every other way is each page's.
   */
  const casesFor = (purpose: LinkPurpose): Record<string, () => Promise<string>> => ({
    unknown: async () => { await seedAna(); return unknownToken(); },
    "the wrong shape": async () => { await seedAna(); return "not-a-token"; },
    used: async () => {
      const { ana } = await seedAna(); const token = await mintLink(ana.id, purpose);
      await db.update(parentSigninToken).set({ usedAt: new Date() }); return token;
    },
    expired: async () => { const { ana } = await seedAna(); return mintLink(ana.id, purpose, new Date(Date.now() - LINK_LIFE_MS[purpose] - 1000)); },
    ...(purpose === "setup" ? {
      "a set-up link for someone with a password": async () => { const { ana } = await seedAna(); await seedPassword(ana.authUserId, OTHER); return mintLink(ana.id, "setup"); },
    } : {}),
    "the other page's token": async () => { const { ana } = await seedAna(); return mintLink(ana.id, otherPurpose(purpose)); },
    blocked: async () => { const { ana } = await seedAna({ blocked: true }); return mintLink(ana.id, purpose); },
    "no row that counts": async () => {
      const { ana, row } = await seedAna(); await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, row.id));
      return mintLink(ana.id, purpose);
    },
    "no sign-in account": async () => {
      const { ana } = await seedAna(); await db.delete(parentAuthUser).where(eq(parentAuthUser.parentId, ana.id)); return mintLink(ana.id, purpose);
    },
    "sign-ins off": async () => { const { ana } = await seedAna(); const token = await mintLink(ana.id, purpose); await seedParentSettings({ signin: false }); return token; },
  });
  const PURPOSES = ["setup", "reset"] as const;

  it.each(PURPOSES)("the %s page shows one message, the same HTML, and its action gives one answer, whatever the reason; the page writes nothing", async (purpose) => {
    const pages = new Map<string, string>(), answers = new Map<string, string>();
    for (const [name, make] of Object.entries(casesFor(purpose))) {
      await resetDb();
      const token = await make();
      const before = await written();
      const html = await page(purpose, token);
      expect(await written(), `${name}: opening the page wrote something`).toEqual(before);
      // React writes ' in text as &#x27;.
      expect(html, name).toContain(PASSWORD_COPY.linkNoGoodTitle.replaceAll("'", "&#x27;"));
      expect(html, name).not.toContain('type="password"');
      pages.set(name, html);
      answers.set(name, JSON.stringify(await choose(purpose, token)));
      // The action refused and made no password (the one case that had one before keeps it alone).
      expect(await db.select().from(parentAuthAccount), name).toHaveLength(name === "a set-up link for someone with a password" ? 1 : 0);
    }
    expect(new Set(pages.values()).size).toBe(1);
    expect(new Set(answers.values())).toEqual(new Set([JSON.stringify(REFUSED)]));
  }, 120_000);

  it.each(PURPOSES)("the %s action records each refusal with its reason, for the audit log only", async (purpose) => {
    const reasons: Record<string, string> = { unknown: "unknown", used: "used", expired: "expired", "the other page's token": "unknown", blocked: "blocked",
      "no row that counts": "no_enabled_guardian", "no sign-in account": "no_sign_in_account", "sign-ins off": "signins_off",
      ...(purpose === "setup" ? { "a set-up link for someone with a password": "has_password" } : {}) };
    const cases = casesFor(purpose);
    // Every way but the bad request has its reason here.
    expect(Object.keys(cases).filter((name) => name !== "the wrong shape").sort()).toEqual(Object.keys(reasons).sort());
    for (const [name, reason] of Object.entries(reasons)) {
      await resetDb();
      const token = await cases[name]!();
      expect(await choose(purpose, token)).toEqual(REFUSED);
      const [row] = await audits("parent.password.refused");
      expect(row, name).toMatchObject({ door: "parent", after: { purpose, reason }, ip: IP });
      // An unknown token names nobody: the row has no person.
      if (reason === "unknown") expect(row, name).toMatchObject({ actorId: null, targetId: null });
      else expect(row!.targetType, name).toBe("parent");
    }
    // The wrong shape is a bad request: refused before anything is counted or recorded.
    await resetDb();
    expect(await choose(purpose, await cases["the wrong shape"]!())).toEqual(REFUSED);
    expect(await audits("parent.password.refused")).toEqual([]);
    expect(await db.select().from(rateLimitEvent)).toEqual([]);
  }, 120_000);

  it("opening a live link writes nothing and shows the form, with no name, address or family", async () => {
    const { ana } = await seedAna();
    for (const purpose of ["setup", "reset"] as const) {
      const token = await mintLink(ana.id, purpose);
      const before = await written();
      const html = await page(purpose, token);
      expect(await written()).toEqual(before);
      expect(html).toContain(purpose === "setup" ? PASSWORD_COPY.setupTitle : PASSWORD_COPY.resetTitle);
      expect(html).toContain('autocomplete="new-password"');
      for (const secret of ["Zebrafish", "ana@example.com", "Quokka"]) expect(html, secret).not.toContain(secret);
      // No username is offered to a password manager.
      expect(html).not.toContain('autocomplete="username"');
    }
  });

  it("refuses bad arguments as a bad request: not a purpose, not a string, too long", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    for (const args of [["admin", token], ["setup", 42], ["setup", token, 12, 12], ["setup", token, GOOD, null], ["setup", token, "x".repeat(1025), "x".repeat(1025)]] as unknown[][]) {
      expect(await choose(...(args as [unknown, unknown, unknown?, unknown?]))).toEqual(REFUSED);
    }
    expect(await credentialRows(ana.authUserId)).toEqual([]);
    expect(await linkVerdict("setup", token)).toMatchObject({ ok: true });
  });
});

describe("setting a password from a link", () => {
  beforeEach(async () => { await resetDb(); mode = "answer"; fromIp(IP); });

  it("a set-up link inserts one credential row that verifies, spends the link and ends nothing", async () => {
    const { ana, row } = await seedAna();
    await seedParentSession(ana.authUserId, { familyId: row.familyId });
    await seedDevice(ana.id);
    await seedCode(ana.id);
    const token = await mintLink(ana.id, "setup");
    expect(await choose("setup", token)).toEqual({ ok: true, message: PASSWORD_COPY.set });
    const creds = await credentialRows(ana.authUserId);
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({ providerId: "credential", accountId: ana.authUserId, userId: ana.authUserId });
    expect(await verifyPassword({ hash: creds[0]!.password!, password: GOOD })).toBe(true);
    expect((await linkRows(ana.id))[0]!.usedAt).not.toBeNull();
    // A set-up ends nothing: the session, the device and the code stay.
    expect(await db.select().from(parentAuthSession)).toHaveLength(1);
    expect(await db.select().from(parentDevice)).toHaveLength(1);
    expect(await db.select().from(signinCode)).toHaveLength(1);
    const [set] = await audits("parent.password.set");
    expect(set).toMatchObject({ door: "parent", actorId: ana.id, actorLabel: "ana@example.com", targetType: "parent", targetId: ana.id, ip: IP });
    expect(set!.after).toEqual({ purpose: "setup", replaced: false, breachChecked: true });
    for (const secret of [GOOD, creds[0]!.password!, token, hashLinkToken("setup", token)]) expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(secret);
    // Used, the link is refused, and a set-up link made now is refused too: the person has a password.
    expect(await choose("setup", token)).toEqual(REFUSED);
    expect((await audits("parent.password.refused")).at(-1)).toMatchObject({ after: { reason: "used" } });
    expect(await choose("setup", await mintLink(ana.id, "setup"))).toEqual(REFUSED);
    expect((await audits("parent.password.refused")).at(-1)).toMatchObject({ after: { reason: "has_password" } });
  });

  it("a reset link replaces the password, still one row, ends every session, forgets every device and deletes unused codes", async () => {
    const { ana, row } = await seedAna();
    await seedPassword(ana.authUserId, OTHER);
    await seedParentSession(ana.authUserId, { familyId: row.familyId });
    await seedParentSession(ana.authUserId);
    await seedDevice(ana.id); await seedDevice(ana.id);
    await seedCode(ana.id);
    const token = await mintLink(ana.id, "reset");
    expect(await choose("reset", token)).toEqual({ ok: true, message: PASSWORD_COPY.set });
    const creds = await credentialRows(ana.authUserId);
    expect(creds).toHaveLength(1);
    expect(await verifyPassword({ hash: creds[0]!.password!, password: GOOD })).toBe(true);
    expect(await verifyPassword({ hash: creds[0]!.password!, password: OTHER })).toBe(false);
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await db.select().from(parentDevice)).toEqual([]);
    expect(await db.select().from(signinCode)).toEqual([]);
    expect((await audits("parent.password.set"))[0]!.after).toEqual({ purpose: "reset", replaced: true, breachChecked: true, codesDeleted: 1, devicesForgotten: 2, sessionsEnded: 2 });
    expect(await choose("reset", token)).toEqual(REFUSED);
  });

  it("a code sign-in whose code was spent before a reset committed, and whose session is made after it, is refused at its last check", async () => {
    const { ana } = await seedAna();
    await seedPassword(ana.authUserId, OTHER);
    // A code spent before a code's life ago is the clean-up's; the one the door is about to spend is right.
    const old = await seedCode(ana.id, { usedAt: new Date(Date.now() - CODE_TTL_MS - 60_000) });
    await seedCode(ana.id, { code: "123456" });
    const token = await mintLink(ana.id, "reset");
    // The code door's first step (src/lib/auth/parent-code-plugin.ts): the code is right, and spent.
    const spent = await verifySigninCode("ana@example.com", "123456", IP);
    if (!spent.ok) expect.fail(`the code was refused: ${JSON.stringify(spent)}`);
    // The reset commits before the door makes its session: there is no session to end yet.
    expect(await choose("reset", token)).toEqual({ ok: true, message: PASSWORD_COPY.set });
    expect((await audits("parent.password.set"))[0]!.after).toMatchObject({ purpose: "reset", codesDeleted: 1, sessionsEnded: 0 });
    expect((await db.select().from(signinCode)).map((c) => c.id)).toEqual([old]);
    // Then the door makes the session, and its last check, which reads the code it spent again, refuses it.
    await seedParentSession(ana.authUserId);
    expect(await signinStands(ana.id, "ana@example.com", IP, spent.codeId)).toBe(false);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ targetId: ana.id, after: { reason: "code_gone" }, ip: IP });
  });

  it("two submits at once for one link set the password once", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    const results = await Promise.all([choose("setup", token), choose("setup", token, OTHER)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([REFUSED]);
    expect(await credentialRows(ana.authUserId)).toHaveLength(1);
    expect(await audits("parent.password.set")).toHaveLength(1);
  }, 30_000);

  it("a set-up beside a reset for one person leaves one credential row, and a set row for each that went through", async () => {
    const { ana } = await seedAna();
    const setup = await mintLink(ana.id, "setup"), reset = await mintLink(ana.id, "reset");
    const results = await Promise.all([choose("setup", setup), choose("reset", reset, OTHER)]);
    expect(await credentialRows(ana.authUserId)).toHaveLength(1);
    expect(await audits("parent.password.set")).toHaveLength(results.filter((r) => r.ok).length);
    // The reset goes through either way; the set-up only if it came first.
    expect(results[1]).toEqual({ ok: true, message: PASSWORD_COPY.set });
  }, 30_000);

  it("says what is wrong with a password, leaves the link unspent, and counts each try", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    expect(await choose("setup", token, GOOD, OTHER)).toEqual({ ok: false, errors: [PASSWORD_COPY.mismatch] });
    expect(await choose("setup", token, "eleven char")).toEqual({ ok: false, errors: [PASSWORD_COPY.tooShort] });
    expect(await choose("setup", token, "x".repeat(129))).toEqual({ ok: false, errors: [PASSWORD_COPY.tooLong] });
    expect(PASSWORD_COPY.tooShort).toContain("12 characters");
    expect(PASSWORD_COPY.tooLong).toContain("128 characters");
    expect((await audits("parent.password.refused")).map((r) => (r.after as { reason: string }).reason)).toEqual(["mismatch", "too_short", "too_long"]);
    expect(await db.select().from(rateLimitEvent).where(eq(rateLimitEvent.kind, "password_link_token"))).toHaveLength(3);
    expect(await linkVerdict("setup", token)).toMatchObject({ ok: true });
    expect(await choose("setup", token)).toMatchObject({ ok: true });
  });

  it("refuses a password found in a breach in words and leaves the link unspent; takes one not found as checked", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    expect(await choose("setup", token, BREACHED)).toEqual({ ok: false, errors: [PASSWORD_COPY.breached] });
    expect(PASSWORD_COPY.breached).toMatch(/known data breach/);
    expect((await audits("parent.password.refused"))[0]).toMatchObject({ after: { purpose: "setup", reason: "breached" } });
    expect(await credentialRows(ana.authUserId)).toEqual([]);
    expect(await linkVerdict("setup", token)).toMatchObject({ ok: true });
    expect(await choose("setup", token)).toMatchObject({ ok: true });
    expect((await audits("parent.password.set"))[0]!.after).toMatchObject({ breachChecked: true });
    expect(await readBreachMark()).toMatchObject({ answeredAt: expect.any(String), failedAt: null, failedLast: false });
  });

  it("takes a password the breach check couldn't check, and says so in its audit row and the Health mark", async () => {
    const { ana } = await seedAna();
    mode = "down";
    expect(await choose("setup", await mintLink(ana.id, "setup"))).toEqual({ ok: true, message: PASSWORD_COPY.set });
    expect((await audits("parent.password.set"))[0]!.after).toEqual({ purpose: "setup", replaced: false, breachChecked: false, breachNotChecked: "bad_answer" });
    expect(await readBreachMark()).toMatchObject({ answeredAt: null, failedAt: expect.any(String), failure: "bad_answer", failedLast: true });
    // The mark holds times and a code only.
    expect(JSON.stringify(await readBreachMark())).not.toContain(GOOD.slice(0, 5));
  });
});

describe("the check under the person's lock", () => {
  beforeEach(async () => { await resetDb(); mode = "answer"; hold = null; fromIp(IP); });
  afterEach(() => { hold = null; });

  /** What happens to the link while the breach check is being asked, and the reason the re-check under the lock gives. */
  const MEANWHILE: Record<string, { reason: string; change: (o: { parentId: string; tokenId: string }) => Promise<unknown> }> = {
    "the person is blocked": { reason: "blocked", change: ({ parentId }) => db.update(parent).set({ blocked: true }).where(eq(parent.id, parentId)) },
    "sign-ins are switched off": { reason: "signins_off", change: () => seedParentSettings({ signin: false }) },
    // Its life ends now, after the action began: the re-check reads the time once it holds the person's row.
    "the link runs out": { reason: "expired", change: ({ tokenId }) => db.update(parentSigninToken).set({ expiresAt: new Date() }).where(eq(parentSigninToken.id, tokenId)) },
    "the link is spent": { reason: "used", change: ({ tokenId }) => db.update(parentSigninToken).set({ usedAt: new Date() }).where(eq(parentSigninToken.id, tokenId)) },
  };

  it.each(Object.keys(MEANWHILE))("refuses, changing nothing, a link that stops being usable while the breach check is asked: %s", async (what) => {
    const { ana, row } = await seedAna();
    await seedPassword(ana.authUserId, OTHER);
    await seedParentSession(ana.authUserId, { familyId: row.familyId });
    const token = await mintLink(ana.id, "reset");
    const [link] = await linkRows(ana.id);
    let asked!: () => void, release!: () => void;
    const wasAsked = new Promise<void>((r) => { asked = r; });
    hold = { asked: () => asked(), until: new Promise<void>((r) => { release = r; }) };
    const answer = choose("reset", token);
    await wasAsked;
    // The breach check runs with nothing held: the person's row is free while the service is asked.
    await db.transaction((tx) => tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ana.id)).for("update", { noWait: true }));
    await MEANWHILE[what]!.change({ parentId: ana.id, tokenId: link!.id });
    release();
    expect(await answer).toEqual(REFUSED);
    const creds = await credentialRows(ana.authUserId);
    expect(creds).toHaveLength(1);
    expect(await verifyPassword({ hash: creds[0]!.password!, password: OTHER })).toBe(true);
    expect(await db.select().from(parentAuthSession)).toHaveLength(1);
    expect(await audits("parent.password.set")).toEqual([]);
    expect((await audits("parent.password.refused")).at(-1)).toMatchObject({ targetId: ana.id, after: { purpose: "reset", reason: MEANWHILE[what]!.reason } });
  }, 30_000);

  it("waits for the person's row, then checks again what the holder left", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    let answer!: Promise<unknown>;
    await db.transaction(async (tx) => {
      await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ana.id)).for("update");
      answer = choose("setup", token);
      await untilALockIsAwaited();
      await tx.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    });
    expect(await answer).toEqual(REFUSED);
    expect(await credentialRows(ana.authUserId)).toEqual([]);
    expect((await audits("parent.password.refused")).at(-1)).toMatchObject({ after: { reason: "blocked" } });
  }, 30_000);
});

describe("the limits on a link's form", () => {
  beforeEach(async () => { await resetDb(); mode = "answer"; fromIp(IP); });

  it("refuses a link past its tries with the same answer as a refused link, audited once", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    for (let i = 0; i < RATE_LIMITS.password_link_token.max; i++) expect(await choose("setup", token, GOOD, OTHER)).toMatchObject({ ok: false, errors: [PASSWORD_COPY.mismatch] });
    expect(await choose("setup", token)).toEqual(REFUSED);
    expect(await choose("setup", token)).toEqual(REFUSED);
    expect((await audits("parent.password.refused")).filter((r) => (r.after as { reason: string }).reason === "rate_limited"))
      .toMatchObject([{ actorId: null, after: { purpose: "setup", reason: "rate_limited", limit: "token" } }]);
    expect(await credentialRows(ana.authUserId)).toEqual([]);
    // Counted under the token's hash, never the token.
    const subjects = (await db.select().from(rateLimitEvent).where(eq(rateLimitEvent.kind, "password_link_token"))).map((r) => r.subject);
    expect(new Set(subjects)).toEqual(new Set([hashLinkToken("setup", token)]));
  }, 60_000);

  it("refuses an address past its tries, and counts nothing per address when the address is unknown", async () => {
    const { ana } = await seedAna();
    const token = await mintLink(ana.id, "setup");
    for (let i = 0; i < RATE_LIMITS.password_link_ip.max; i++) await takeRateLimit("password_link_ip", IP);
    expect(await choose("setup", token)).toEqual(REFUSED);
    expect((await audits("parent.password.refused"))[0]).toMatchObject({ after: { reason: "rate_limited", limit: "ip" } });
    expect(await credentialRows(ana.authUserId)).toEqual([]);
    // With no address the limit per address is skipped: the per-link one still holds.
    fromIp("");
    expect(await choose("setup", token)).toMatchObject({ ok: true });
    expect(await db.select().from(rateLimitEvent).where(eq(rateLimitEvent.kind, "password_link_ip"))).toHaveLength(RATE_LIMITS.password_link_ip.max);
    expect((await audits("parent.password.set"))[0]).toMatchObject({ ip: null });
  });

  it("pins the two limits", () => {
    expect(RATE_LIMITS.password_link_ip).toEqual({ max: 60, windowMs: 15 * 60_000 });
    expect(RATE_LIMITS.password_link_token).toEqual({ max: 10, windowMs: 15 * 60_000 });
  });
});
