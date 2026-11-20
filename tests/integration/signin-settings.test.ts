import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { asParent, fromIp, renderPage } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// The breach service is a stub listening on port 0, as in password-links.test.ts.
const where = vi.hoisted(() => ({ range: "" }));
vi.mock("@/lib/parents/breach-endpoints", () => ({ breachEndpoints: () => ({ range: where.range }) }));

import { and, eq, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { auditLog, parentAuthAccount, parentAuthSession, parentAuthUser, parentDevice, parentSigninToken, rateLimitEvent, signinCode } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { askAgainCode } from "@/lib/parents/asking-again";
import { hashTriedAddress } from "@/lib/parents/password-signin";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { CODE_TTL_MS } from "@/lib/parents/signin-codes";
import SignInSettingsPage from "@/app/(parent)/family/sign-in/page";
import FamilyPage from "@/app/(parent)/family/page";
import { askAgainCodeAction, askAgainPasswordAction, askSetupLinkAction, changePasswordAction, signOutEverywhereAction } from "@/app/(parent)/family/sign-in/actions";
import { resetDb, seedParentSession, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, PROVEN_PASSWORD, identityNow, proveRecently, seedParentIn, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { seedParentSettings } from "../helpers/roster-cache";
import { codeMailed } from "../helpers/parent-door";
import { linkRows, mintLink, seedCode, seedDevice, seedPassword } from "../helpers/signin-links";

/**
 * A parent's sign-in settings (/family/sign-in; the sign-in release, slice SI-5a): the page, asking again (the door's
 * password check, then its emailed code, with a stamp between them that names no id), changing the password, signing
 * out everywhere and the set-up link offered to a person with no password. Every action is called as the signed-in
 * parent; whose password, sessions and code are the session's own.
 */
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();
const NEW_PASSWORD = "a brand new phrase for the portal, long enough";
const BREACHED = "password-from-a-breach-1234";
let breachDown = false;
let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (breachDown) { res.writeHead(503).end(); return; }
    const prefix = (req.url ?? "").split("/").pop()!;
    const seen = sha1(BREACHED);
    const lines = [`${"0".repeat(35)}:0`, ...(seen.startsWith(prefix) ? [`${seen.slice(5)}:42`] : [])];
    res.writeHead(200, { "content-type": "text/plain" }).end(lines.join("\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  where.range = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

const IP = "203.0.113.71";
beforeEach(async () => { await resetDb(); outbox.length = 0; breachDown = false; await seedWorkingMail(); fromIp(IP); });

/** React writes an apostrophe in text as &#x27;. */
const html = (words: string) => words.replace(/'/g, "&#x27;");
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const authUserOf = async (parentId: string) => (await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))[0]!.id;
const sessionsOf = (parentId: string) => db.select({ id: parentAuthSession.id, strongAt: parentAuthSession.strongAt }).from(parentAuthSession)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthSession.userId)).where(eq(parentAuthUser.parentId, parentId));
// Read through sql<Date>: drizzle's inferred type of this column of the Better Auth tables comes out as never (schema.ts).
const strongAtOf = async (sessionId: string): Promise<Date | null> => (await db.select({ strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt) })
  .from(parentAuthSession).where(eq(parentAuthSession.id, sessionId)))[0]?.strongAt ?? null;
const credentialOf = async (parentId: string) => (await db.select().from(parentAuthAccount)
  .where(and(eq(parentAuthAccount.userId, await authUserOf(parentId)), eq(parentAuthAccount.providerId, "credential"))))[0];
const devicesOf = (parentId: string) => db.select().from(parentDevice).where(eq(parentDevice.parentId, parentId));
const codesOf = (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));
const allSessions = () => db.select({ id: parentAuthSession.id }).from(parentAuthSession);
const ctxOf = (identity: ParentIdentity) => ({ ...identity, ip: IP });

/** The parent with a password chosen a minute ago, and no proof on their session (as a session from before SI-3b). */
async function withPassword(seeded: { identity: ParentIdentity }): Promise<void> {
  await seedPassword(await authUserOf(seeded.identity.parentId), PROVEN_PASSWORD, new Date(Date.now() - 60_000));
}
/** The first step, as the page sends it, and the code it mailed. */
async function passwordThenCode(identity: ParentIdentity): Promise<{ stamp: string; code: string }> {
  asParent(identity);
  const since = outbox.length;
  const first = await askAgainPasswordAction(PROVEN_PASSWORD);
  expect(first).toEqual({ ok: true, message: COPY.codeSent, stamp: expect.stringMatching(/^\d{13}\.[A-Za-z0-9_-]{43}$/) });
  if (!first.ok) throw new Error("unreachable");
  return { stamp: first.stamp, code: await codeMailed(outbox, identity.email, since) };
}

describe("the page", () => {
  it("is linked from the Family page's Your account box", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    asParent(a.identity);
    expect(await renderPage(FamilyPage)).toContain(`<a class="btn btn-line" href="/family/sign-in">Sign-in settings</a>`);
  });

  it("with a password and a proof just now: the change form, and nothing of the session, the person or the password", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    asParent(a.identity);
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(COPY.title);
    expect(page).toContain(FAMILY_A.parent.email);
    expect(page).toContain(COPY.passwordChosen);
    expect(page.match(/autocomplete="new-password"/gi)).toHaveLength(2);
    expect(page).not.toMatch(/autocomplete="current-password"/i);
    expect(page).toContain(html(COPY.signsOutEverywhere));
    expect(page).toContain(COPY.everywhereButton);
    expect(page).toContain(html(COPY.devicesSoon));
    expect(page).toContain(html(COPY.moreSoon));
    const credential = await credentialOf(a.identity.parentId);
    for (const secret of [a.identity.sessionId, a.session.token, a.identity.parentId, a.identity.guardianId, credential!.id, credential!.password!]) expect(page).not.toContain(secret);
  });

  it("with a password and no recent proof, a proof 11 minutes old, or one stamped ahead of the clock: the asking again", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    for (const strongAt of [null, new Date(Date.now() - 11 * 60_000), new Date(Date.now() + 60_000)]) {
      await db.update(parentAuthSession).set({ strongAt }).where(eq(parentAuthSession.id, a.identity.sessionId));
      const page = await renderPage(SignInSettingsPage);
      expect(page, String(strongAt)).toContain(html(COPY.askAgainForPassword));
      expect(page).toMatch(/autocomplete="current-password"/i);
      // The address a password manager files the password under, as the page already shows it.
      expect(page).toMatch(/autocomplete="username"/i);
      expect(page).not.toMatch(/autocomplete="new-password"/i);
      expect(page).toContain(COPY.everywhereButton);
    }
  });

  it("with no password: the offer of a link to choose one, and no password field", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    asParent(a.identity);
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(COPY.passwordNotChosen);
    expect(page).toContain(html(COPY.noPassword));
    expect(page).toContain(COPY.setupButton);
    expect(page).not.toContain(`type="password"`);
    expect(page).toContain(COPY.everywhereButton);
  });

  it("under Strict: nothing to change here yet, in words; signing out everywhere still offered", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    await seedParentSettings({ level: "strict" });
    asParent(a.identity);
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(html(COPY.strict));
    expect(page).not.toContain(`type="password"`);
    expect(page).toContain(COPY.everywhereButton);
  });
});

describe("asking again", () => {
  it("the right password, then the right code: this session's strong_at is stamped, no other's, and no session is made", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const other = await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    const sessionsBefore = (await allSessions()).length;
    const { stamp, code } = await passwordThenCode(a.identity);
    // The stamp names nothing: no session, person or password row.
    const credential = await credentialOf(a.identity.parentId);
    for (const id of [a.identity.sessionId, a.identity.parentId, credential!.id]) expect(stamp).not.toContain(id);
    expect(await audits("signin.second_step_asked")).toHaveLength(1);

    const before = Date.now();
    expect(await askAgainCodeAction(stamp, code)).toEqual({ ok: true, message: COPY.proved });
    expect((await strongAtOf(a.identity.sessionId))!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await strongAtOf(other.id)).toBeNull();
    expect((await allSessions()).length).toBe(sessionsBefore);
    const proved = await audits("signin.proved_again");
    expect(proved.map((r) => [r.targetType, r.targetId, r.after])).toEqual([["parent", a.identity.parentId, { step: "emailed_code" }]]);
    expect(JSON.stringify(proved)).not.toContain(code);
    expect(JSON.stringify(proved)).not.toContain(stamp);
    // The page is drawn again with the change form.
    expect(await renderPage(SignInSettingsPage)).toMatch(/autocomplete="new-password"/i);
  });

  it("a wrong password is counted as the door counts it, and the sixth is refused in the over-limit words", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    for (let i = 0; i < 5; i++) expect(await askAgainPasswordAction("not the password at all")).toEqual({ ok: false, errors: [COPY.passwordRejected] });
    expect(await askAgainPasswordAction(PROVEN_PASSWORD)).toEqual({ ok: false, errors: [COPY.tooManyTries] });
    const counted = await db.select().from(rateLimitEvent).where(and(eq(rateLimitEvent.kind, "password_try_email"), eq(rateLimitEvent.subject, hashTriedAddress(FAMILY_A.parent.email))));
    expect(counted).toHaveLength(5);
    expect(await audits("signin.password_wrong")).toHaveLength(5);
    expect(outbox).toEqual([]);
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
  });

  it("a code with a stamp of another session, of another person, from before the password changed, or past its end is refused, and stamps nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await withPassword(a); await withPassword(b);
    const second = await identityNow((await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId })).id);
    const mine = await passwordThenCode(a.identity);
    const theirs = await passwordThenCode(b.identity);

    // Another session of the same person, and another person, with a stamp that is not theirs.
    asParent(second);
    expect(await askAgainCodeAction(mine.stamp, mine.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });
    asParent(a.identity);
    expect(await askAgainCodeAction(theirs.stamp, theirs.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });
    expect(await askAgainCodeAction(theirs.stamp, mine.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });
    // Past its end (as read CODE_TTL_MS and a moment later).
    expect(await askAgainCode(ctxOf(a.identity), mine.stamp, mine.code, new Date(Date.now() + CODE_TTL_MS + 1000))).toEqual({ ok: false, errors: [COPY.codeRejected] });
    // A stamp is no stamp once the password it was made for has been replaced.
    const [credential] = await db.select({ id: parentAuthAccount.id }).from(parentAuthAccount).where(eq(parentAuthAccount.userId, await authUserOf(a.identity.parentId)));
    await db.update(parentAuthAccount).set({ updatedAt: new Date() }).where(eq(parentAuthAccount.id, credential!.id));
    expect(await askAgainCodeAction(mine.stamp, mine.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });

    for (const s of [a.identity.sessionId, second.sessionId, b.identity.sessionId]) expect(await strongAtOf(s)).toBeNull();
    // None of those refusals reached a code: each person's code is unused and untried.
    for (const p of [a.identity.parentId, b.identity.parentId]) expect((await codesOf(p)).map((c) => [c.usedAt, c.tries])).toEqual([[null, 0]]);
    expect(await audits("signin.proved_again")).toEqual([]);
  });
});

describe("changing the password", () => {
  it("is refused without a recent proof, changing nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    const before = await credentialOf(a.identity.parentId);
    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: false, errors: [COPY.proveAgain] });
    expect(await credentialOf(a.identity.parentId)).toEqual(before);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await audits("parent.password.changed")).toEqual([]);
  });

  it("is refused for a breached password, one too short and two that differ, in words, changing nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    asParent(a.identity);
    const before = await credentialOf(a.identity.parentId);
    expect(await changePasswordAction(BREACHED, BREACHED)).toEqual({ ok: false, errors: [PASSWORD_COPY.breached] });
    expect(await changePasswordAction("too short", "too short")).toEqual({ ok: false, errors: [PASSWORD_COPY.tooShort] });
    expect(await changePasswordAction(NEW_PASSWORD, `${NEW_PASSWORD}!`)).toEqual({ ok: false, errors: [PASSWORD_COPY.mismatch] });
    expect(await credentialOf(a.identity.parentId)).toEqual(before);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await audits("parent.password.changed")).toEqual([]);
  });

  it("taken: the password replaced, the codes, links and devices gone, every session of the person ended (this one too) and nobody else's, one row, one notice", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await proveRecently(a.identity);
    await withPassword(b);
    await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    await seedCode(a.identity.parentId);
    await mintLink(a.identity.parentId, "reset");
    await seedDevice(a.identity.parentId);
    await seedDevice(b.identity.parentId);
    await seedCode(b.identity.parentId);
    const theirsBefore = { credential: await credentialOf(b.identity.parentId), sessions: await sessionsOf(b.identity.parentId), devices: await devicesOf(b.identity.parentId), codes: await codesOf(b.identity.parentId) };
    const before = await credentialOf(a.identity.parentId);
    asParent(a.identity);

    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: true, message: COPY.changed });
    const after = await credentialOf(a.identity.parentId);
    expect(after!.id).toBe(before!.id);
    expect(await verifyPassword({ hash: after!.password!, password: NEW_PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: after!.password!, password: PROVEN_PASSWORD })).toBe(false);
    expect(await codesOf(a.identity.parentId)).toEqual([]);
    expect((await linkRows(a.identity.parentId)).filter((l) => l.usedAt === null)).toEqual([]);
    expect(await devicesOf(a.identity.parentId)).toEqual([]);
    expect(await sessionsOf(a.identity.parentId)).toEqual([]);
    // Nobody else's.
    expect({ credential: await credentialOf(b.identity.parentId), sessions: await sessionsOf(b.identity.parentId), devices: await devicesOf(b.identity.parentId), codes: await codesOf(b.identity.parentId) }).toEqual(theirsBefore);

    const rows = await audits("parent.password.changed");
    expect(rows.map((r) => [r.targetType, r.targetId, r.after])).toEqual([["parent", a.identity.parentId,
      { breachChecked: true, codesDeleted: 1, linksDeleted: 1, devicesForgotten: 1, sessionsEnded: 2 }]]);
    expect(JSON.stringify(rows)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(rows)).not.toContain(after!.password!);
    // One notice, to the address held at that moment, and to nobody else.
    await vi.waitFor(() => expect(outbox.filter((m) => m.subject.endsWith("password was changed"))).toHaveLength(1));
    const notice = outbox.find((m) => m.subject.endsWith("password was changed"))!;
    expect(notice.to).toBe(FAMILY_A.parent.email);
    expect(notice.text).toContain("http://localhost:3000/sign-in/password");
    expect(outbox.map((m) => m.to)).toEqual([FAMILY_A.parent.email]);
    for (const s of [FAMILY_A.family.name, ...FAMILY_A.students.map((x) => x.name), FAMILY_A.parent.name]) expect(`${notice.text}${notice.html}`).not.toContain(s);
  });

  it("takes a password the breach service couldn't check, and says so in its row", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    breachDown = true;
    asParent(a.identity);
    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: true, message: COPY.changed });
    expect((await audits("parent.password.changed"))[0]!.after).toEqual({ breachChecked: false, breachNotChecked: "bad_answer", codesDeleted: 0, linksDeleted: 0, devicesForgotten: 0, sessionsEnded: 1 });
  });
});

describe("signing out everywhere", () => {
  it("ends every session and forgets every device of the person, and nobody else's, with no recent proof", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    await seedDevice(a.identity.parentId);
    await seedDevice(b.identity.parentId);
    asParent(a.identity);
    expect(await signOutEverywhereAction()).toEqual({ ok: true, message: COPY.everywhereDone });
    expect(await sessionsOf(a.identity.parentId)).toEqual([]);
    expect(await devicesOf(a.identity.parentId)).toEqual([]);
    expect(await sessionsOf(b.identity.parentId)).toHaveLength(1);
    expect(await devicesOf(b.identity.parentId)).toHaveLength(1);
    expect((await audits("parent.sessions.end_all")).map((r) => [r.targetType, r.targetId, r.after])).toEqual([["parent", a.identity.parentId, { devicesForgotten: 1, sessionsEnded: 2 }]]);
  });
});

describe("the set-up link offered to a person with no password", () => {
  it("mails one link to the session's own address and answers as the request page does", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    asParent(a.identity);
    expect(await askSetupLinkAction()).toEqual({ ok: true, message: PASSWORD_COPY.askAnswer });
    await vi.waitFor(async () => expect((await linkRows(a.identity.parentId)).filter((l) => l.usedAt === null && l.purpose === "setup")).toHaveLength(1));
    expect(outbox.map((m) => m.to)).toEqual([FAMILY_A.parent.email]);
    expect(outbox[0]!.text).toMatch(/\/sign-in\/set-up\/[A-Za-z0-9_-]{43}/);
    expect(await credentialOf(a.identity.parentId)).toBeUndefined();
  });
});

describe("one parent never reaches another's sign-in", () => {
  it("as family A's parent: family B's stamp, a stamp made for a second guardian of family A, and values of the wrong type and size change nothing of theirs, and are the one refusal", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b: SeededParent = await seedSignedInParent(FAMILY_B);
    const second = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Secondguardian", email: "sigrid.second@family-a.example" });
    for (const p of [a, b, second]) await withPassword(p);
    await seedDevice(b.identity.parentId);
    await seedDevice(second.identity.parentId);
    const theirStamp = await passwordThenCode(b.identity);
    const secondStamp = await passwordThenCode(second.identity);
    const theirs = async () => Promise.all([b.identity, second.identity].map(async (i) => ({
      credential: await credentialOf(i.parentId), sessions: await sessionsOf(i.parentId), devices: await devicesOf(i.parentId), codes: await codesOf(i.parentId),
      links: await db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, i.parentId)),
    })));
    const before = await theirs();

    asParent(a.identity);
    const CODE_NO = { ok: false, errors: [COPY.codeRejected] };
    const PASSWORD_NO = { ok: false, errors: [COPY.passwordRejected] };
    expect(await askAgainCodeAction(theirStamp.stamp, theirStamp.code)).toEqual(CODE_NO);
    expect(await askAgainCodeAction(secondStamp.stamp, secondStamp.code)).toEqual(CODE_NO);
    const odd = [undefined, null, 123456, {}, [], "x".repeat(5000), b.identity.sessionId, b.identity.parentId] as unknown as string[];
    for (const v of odd) {
      expect(await askAgainCodeAction(v, theirStamp.code), String(v)).toEqual(CODE_NO);
      expect(await askAgainCodeAction(theirStamp.stamp, v), String(v)).toEqual(CODE_NO);
      if (typeof v !== "string" || v.length > 1024) expect(await askAgainPasswordAction(v), String(v)).toEqual(PASSWORD_NO);
      if (typeof v !== "string" || v.length > 1024) expect(await changePasswordAction(v, v), String(v)).toEqual({ ok: false, errors: [COPY.failed] });
    }
    // Ids of theirs sent where none is taken are never read: what changes is A's own, or nothing.
    expect(await (askSetupLinkAction as unknown as (x: unknown) => Promise<unknown>)(b.identity.email)).toEqual({ ok: true, message: PASSWORD_COPY.askAnswer });
    expect(await (signOutEverywhereAction as unknown as (x: unknown) => Promise<unknown>)(b.identity.sessionId)).toEqual({ ok: true, message: COPY.everywhereDone });
    expect(await sessionsOf(a.identity.parentId)).toEqual([]);

    expect(await theirs()).toEqual(before);
    for (const s of [b.identity.sessionId, second.identity.sessionId]) expect(await strongAtOf(s)).toBeNull();
    expect(await audits("signin.proved_again")).toEqual([]);
    // Nothing was mailed to anyone but A after their codes went: A has a password, so the ask was a reset link to A.
    await vi.waitFor(() => expect(outbox.some((m) => m.to === FAMILY_A.parent.email)).toBe(true));
    expect(outbox.filter((m) => m.to !== FAMILY_A.parent.email).map((m) => m.to).sort()).toEqual([FAMILY_B.parent.email, "sigrid.second@family-a.example"].sort());
  });
});
