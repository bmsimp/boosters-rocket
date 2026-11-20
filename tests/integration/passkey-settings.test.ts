import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
/**
 * A fault injected from outside src/: while `skipTaken` is above 0, the portal's read of whether a credential is held
 * already (credentialTaken(), called by the add's afterVerification) answers no, once per count, so a second add of one
 * credential reaches the library's insert, which the unique index refuses, as two adds at once would.
 */
const fault = vi.hoisted(() => ({ skipTaken: 0 }));
vi.mock("@/lib/parents/passkeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/parents/passkeys")>();
  return { ...actual, credentialTaken: async (...args: Parameters<typeof actual.credentialTaken>) => {
    if (fault.skipTaken > 0) { fault.skipTaken--; return false; }
    return actual.credentialTaken(...args);
  } };
});

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthPasskey, parentAuthSession, parentAuthUser, parentAuthVerification, parentBackupCode } from "@/lib/db/schema";
import { forgetUnrecordedPasskey, removeMyPasskey, renameMyPasskey } from "@/lib/parents/passkey-settings";
import { passkeysAddedBefore } from "@/lib/parents/passkeys";
import { remakeMyBackupCodes, turnOffMyAuthenticator } from "@/lib/parents/authenticator-settings";
import { changeMyPassword } from "@/lib/parents/signin-settings";
import { sessionProvedRecently } from "@/lib/parents/asking-again";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { resetDb, seedParent, seedGuardianInFamily, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_IP, DOOR_PASSWORD, passwordStep, signInThroughDoor } from "../helpers/parent-door";
import { seedPassword } from "../helpers/signin-links";
import { seedAuthenticator, seedBackupCodes } from "../helpers/authenticator";
import { addPasskey, passkeyAgain, passkeyRows, postAdd, registerOptions, seedPasskey } from "../helpers/passkey";
import { makePasskeyKey } from "../helpers/passkey-keys";

/**
 * Adding, naming and removing passkeys on Sign-in settings, and asking again with one (the sign-in release, slice
 * SI-7b). The library's registration options and the portal's /portal-passkey/add and /portal-passkey/again are
 * reached as a browser reaches them, with a real session cookie from a sign-in through the door (the password and the
 * emailed code, which stamps the session as proved); the presses are called as their actions call them, for the
 * session's own person. The passkeys are made by the software authenticator of tests/helpers/passkey-keys.ts.
 */

const NEW_PASSWORD = "a brand new password, long enough";

/** A person with a password and a guardian row in a family of their own (`familyQboId`), and their name's address. */
async function seedPerson(name: string, familyQboId = "F1") {
  const p = await seedParent({ name, email: `${name.toLowerCase()}@example.com` });
  await seedGuardianInFamily({ parentId: p.id, familyQboId });
  await seedPassword(p.authUserId, DOOR_PASSWORD);
  return p;
}

/** Signs the person in through the door (the password and the emailed code): the session's cookie, its row, and a ctx for the presses. */
async function signedIn(p: { id: string; email: string; authUserId: string }) {
  const r = await signInThroughDoor(outbox as never, p.email);
  expect(r.body).toMatchObject({ ok: true });
  const rows = await db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, p.authUserId));
  expect(rows).toHaveLength(1);
  const s = rows[0]!;
  return { cookie: r.cookie, sessionId: s.id, ctx: { parentId: p.id, sessionId: s.id, email: p.email, ip: DOOR_IP } };
}

const audits = async (action: string) => (await db.select().from(auditLog).where(eq(auditLog.action, action))).map((r) => r.after as Record<string, unknown>);
const backupCodesOf = (parentId: string) => db.select().from(parentBackupCode).where(eq(parentBackupCode.parentId, parentId));
const sessionsOf = async (authUserId: string) => (await db.select({ id: parentAuthSession.id, strongAt: parentAuthSession.strongAt })
  .from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
const proveNow = (sessionId: string) => db.update(parentAuthSession).set({ strongAt: new Date() }).where(eq(parentAuthSession.id, sessionId));

beforeEach(async () => { await resetDb(); outbox.length = 0; fault.skipTaken = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

describe("the registration options (/passkey/generate-register-options)", () => {
  it("are refused, making no challenge row, without a session, without a recent proof, for a blocked person, with sign-ins off, and with any query", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    expect((await registerOptions()).res.status).toBe(404);
    expect((await registerOptions({ cookie: s.cookie, query: "?name=Bitwarden" })).res.status).toBe(404);
    await db.update(parentAuthSession).set({ strongAt: null }).where(eq(parentAuthSession.id, s.sessionId));
    expect((await registerOptions({ cookie: s.cookie })).res.status).toBe(404);
    await proveNow(s.sessionId);
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    expect((await registerOptions({ cookie: s.cookie })).res.status).toBe(404);
    await db.update(parent).set({ blocked: false }).where(eq(parent.id, ana.id));
    await seedParentSettings({ signin: false });
    expect((await registerOptions({ cookie: s.cookie })).res.status).toBe(404);
    expect(await db.select().from(parentAuthVerification)).toEqual([]);
  });

  it("with a recent proof, answer the package's options for the person's own address, excluding their own passkeys alone", async () => {
    const ana = await seedPerson("Ana");
    const ben = await seedPerson("Ben", "F2");
    const s = await signedIn(ana);
    const anaKey = await seedPasskey(ana.id);
    const benKey = await seedPasskey(ben.id);
    await proveNow(s.sessionId);
    const options = await registerOptions({ cookie: s.cookie });
    expect(options.res.status).toBe(200);
    expect(options.body.user?.name).toBe("ana@example.com");
    expect(options.body.user?.displayName).toBe("ana@example.com");
    expect((options.body.excludeCredentials ?? []).map((c) => c.id)).toEqual([anaKey.id]);
    expect(JSON.stringify(options.body)).not.toContain(benKey.id);
    expect(options.body.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(await db.select().from(parentAuthVerification)).toHaveLength(1);
  });
});

describe("adding a passkey (/portal-passkey/add)", () => {
  it("adds one, named or not, the person's own, audited, never used yet; a first with no app answers ten backup codes kept only as hashes, a second none", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const first = await addPasskey(s.cookie, { name: "  Sam's iPhone  " });
    expect(first.body.ok).toBe(true);
    expect(first.body.codes).toHaveLength(10);
    const stored = await backupCodesOf(ana.id);
    expect(stored).toHaveLength(10);
    for (const code of first.body.codes!) expect(JSON.stringify(stored)).not.toContain(code.replace("-", ""));
    // The add stamps nothing, so the next change asks again: prove the session afresh for the second add.
    await proveNow(s.sessionId);
    const second = await addPasskey(s.cookie);
    expect(second.body).toEqual({ ok: true });
    const rows = (await passkeyRows(ana.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows.map((r) => [r.name, r.lastUsedAt])).toEqual([["Sam's iPhone", null], [null, null]]);
    expect(rows.map((r) => r.credentialID).sort()).toEqual([first.key.id, second.key.id].sort());
    const added = await audits("parent.passkey.add");
    expect(added.map((a) => a.passkeys).sort()).toEqual([1, 2]);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(first.key.id);
    expect(await audits("parent.backup_codes.make")).toEqual([{ made: 10, replaced: 0, beside: "passkey" }]);
  });

  it("a first passkey beside an app in force answers no backup codes", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    await seedAuthenticator(ana.id);
    await seedBackupCodes(ana.id);
    await proveNow(s.sessionId);
    expect((await addPasskey(s.cookie)).body).toEqual({ ok: true });
    expect(await backupCodesOf(ana.id)).toHaveLength(10);
  });

  it("refuses a passkey whose user wasn't verified, and one already added, leaving no row", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    expect((await addPasskey(s.cookie, { flags: 0x41 })).body).toEqual({ ok: false, error: "rejected" });
    expect(await passkeyRows(ana.id)).toEqual([]);
    const key = makePasskeyKey();
    expect((await addPasskey(s.cookie, { key })).body.ok).toBe(true);
    await proveNow(s.sessionId);
    expect((await addPasskey(s.cookie, { key })).body).toEqual({ ok: false, error: "already_added" });
    expect(await passkeyRows(ana.id)).toHaveLength(1);
  });

  it("adds nothing with no session, a forged answer, a bad name, or an answer for no options", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    expect((await postAdd({ id: "x" })).body).toEqual({ ok: false, error: "rejected" });
    for (const body of [{}, { response: null }, { response: "x" }, { response: { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "a", attestationObject: "b", extra: "c" } } }]) {
      expect((await postAdd(null, { cookie: s.cookie, body })).body).toEqual({ ok: false, error: "rejected" });
    }
    for (const name of [7, "a\nb", "x".repeat(51)]) expect((await addPasskey(s.cookie, { name })).body).toEqual({ ok: false, error: "rejected" });
    const key = makePasskeyKey();
    const { registrationFor } = await import("../helpers/passkey-keys");
    const { ORIGIN, RP_ID } = await import("../helpers/passkey");
    expect((await postAdd(registrationFor(key, "bm8tb3B0aW9ucw", { origin: ORIGIN, rpId: RP_ID }), { cookie: s.cookie })).body).toEqual({ ok: false, error: "rejected" });
    expect(await passkeyRows(ana.id)).toEqual([]);
  });

  it("a row no audit row names is deleted, audited as not recorded", async () => {
    const ana = await seedPerson("Ana");
    const k = await seedPasskey(ana.id);
    expect(await forgetUnrecordedPasskey({ parentId: ana.id, sessionId: "none", email: ana.email }, k.rowId, DOOR_IP)).toBe(true);
    expect(await passkeyRows(ana.id)).toEqual([]);
    expect(await audits("parent.passkey.remove")).toEqual([{ passkeyId: k.rowId, reason: "not_recorded", passkeys: 0 }]);
  });

  it("then the door asks that person for the passkey and emails no code; no session is ended or made and the proof is left as it was", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const before = await sessionsOf(ana.authUserId);
    expect((await addPasskey(s.cookie)).body.ok).toBe(true);
    expect(await sessionsOf(ana.authUserId)).toEqual(before);
    const mailed = outbox.length;
    expect((await passwordStep(ana.email)).body).toEqual({ ok: true, step: "passkey", app: false });
    expect(outbox.length).toBe(mailed);
  });

  it("after a first add, the next sensitive press asks again, and a passkey proof at /portal-passkey/again lets it through", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const added = await addPasskey(s.cookie);
    expect(added.body.ok).toBe(true);
    const [row] = await passkeyRows(ana.id);
    expect(await removeMyPasskey(s.ctx, row!.id)).toEqual({ ok: false, errors: [COPY.proveAgain] });
    expect(await changeMyPassword(s.ctx, { password: NEW_PASSWORD, again: NEW_PASSWORD })).toEqual({ ok: false, errors: [COPY.proveAgain] });
    expect(await passkeyRows(ana.id)).toHaveLength(1);
    expect((await passkeyAgain(added.key, s.cookie)).body).toEqual({ ok: true });
    expect(await audits("signin.proved_again")).toEqual([{ step: "passkey" }]);
    expect(await sessionProvedRecently(db, s.ctx)).toBe(true);
    expect((await removeMyPasskey(s.ctx, row!.id)).ok).toBe(true);
  });
});

describe("renaming and removing", () => {
  it("renames, refusing names of the wrong type or size, audited with the names before and after", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const k = await seedPasskey(ana.id);
    for (const name of [3, null, "x".repeat(51), "two\nlines"]) expect(await renameMyPasskey(s.ctx, k.rowId, name)).toEqual({ ok: false, errors: [COPY.passkeyNameBad] });
    expect(await renameMyPasskey(s.ctx, k.rowId, " Bitwarden ")).toEqual({ ok: true, message: COPY.passkeyRenamed });
    expect((await passkeyRows(ana.id))[0]!.name).toBe("Bitwarden");
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "parent.passkey.rename"));
    expect([row!.before, row!.after]).toEqual([{ passkeyId: k.rowId, name: null }, { passkeyId: k.rowId, name: "Bitwarden" }]);
  });

  it("removing is refused without a recent proof", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const k = await seedPasskey(ana.id);
    await db.update(parentAuthSession).set({ strongAt: null }).where(eq(parentAuthSession.id, s.sessionId));
    expect(await removeMyPasskey(s.ctx, k.rowId)).toEqual({ ok: false, errors: [COPY.proveAgain] });
    expect(await passkeyRows(ana.id)).toHaveLength(1);
  });

  it("under Standard the last with no app goes with its backup codes, and the door asks for the emailed code again", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const k = await seedPasskey(ana.id);
    await seedBackupCodes(ana.id);
    await proveNow(s.sessionId);
    expect(await removeMyPasskey(s.ctx, k.rowId)).toEqual({ ok: true, message: COPY.passkeyRemovedLast });
    expect(await backupCodesOf(ana.id)).toEqual([]);
    expect(await audits("parent.passkey.remove")).toEqual([{ passkeyId: k.rowId, passkeys: 0, backupCodesDeleted: 10 }]);
    expect((await passwordStep(ana.email)).body).toEqual({ ok: true, step: "code" });
  });

  it("beside an app the last goes and the app is asked", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    await seedAuthenticator(ana.id);
    await seedBackupCodes(ana.id);
    const k = await seedPasskey(ana.id);
    await proveNow(s.sessionId);
    expect(await removeMyPasskey(s.ctx, k.rowId)).toEqual({ ok: true, message: COPY.passkeyRemovedLastApp });
    expect(await backupCodesOf(ana.id)).toHaveLength(10);
    expect((await passwordStep(ana.email)).body).toEqual({ ok: true, step: "app" });
  });

  it("under Strict the last second factor is refused and nothing changes, while one of two goes", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const one = await seedPasskey(ana.id);
    const two = await seedPasskey(ana.id);
    await seedParentSettings({ level: "strict" });
    await proveNow(s.sessionId);
    expect(await removeMyPasskey(s.ctx, one.rowId)).toEqual({ ok: true, message: COPY.passkeyRemoved });
    expect(await removeMyPasskey(s.ctx, two.rowId)).toEqual({ ok: false, errors: [COPY.passkeyRemoveStrict] });
    expect((await passkeyRows(ana.id)).map((r) => r.id)).toEqual([two.rowId]);
  });

  it("turning the app off beside a passkey keeps the backup codes, and Strict allows it", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    await seedAuthenticator(ana.id);
    await seedBackupCodes(ana.id);
    await seedPasskey(ana.id);
    await seedParentSettings({ level: "strict" });
    await proveNow(s.sessionId);
    const before = await sessionsOf(ana.authUserId);
    expect(await turnOffMyAuthenticator(s.ctx)).toEqual({ ok: true, message: COPY.turnedOffBesidePasskey });
    expect(await backupCodesOf(ana.id)).toHaveLength(10);
    expect(await sessionsOf(ana.authUserId)).toEqual(before);
  });
});

describe("one person's passkeys, never another's (as family A's parent, with family B's ids and A's second guardian's)", () => {
  it("renames, removes, adds to and proves with nothing of theirs, and answers the one refusal", async () => {
    const ana = await seedPerson("Ana", "FA");
    const ann = await seedPerson("Ann", "FA");
    const ben = await seedPerson("Ben", "FB");
    const s = await signedIn(ana);
    const b = await signedIn(ben);
    const annKey = await seedPasskey(ann.id);
    const benKey = await seedPasskey(ben.id);
    await proveNow(s.sessionId);
    for (const k of [annKey, benKey]) {
      expect(await renameMyPasskey(s.ctx, k.rowId, "mine now")).toEqual({ ok: false, errors: [COPY.passkeyNotFound] });
      expect(await removeMyPasskey(s.ctx, k.rowId)).toEqual({ ok: false, errors: [COPY.passkeyNotFound] });
    }
    // Ben's own registration challenge, sent with Ana's session: the library's challenge is Ben's, and nothing is added.
    await proveNow(b.sessionId);
    const bensOptions = await registerOptions({ cookie: b.cookie });
    expect(bensOptions.res.status).toBe(200);
    const { registrationFor } = await import("../helpers/passkey-keys");
    const { ORIGIN, RP_ID } = await import("../helpers/passkey");
    const forged = registrationFor(makePasskeyKey(), bensOptions.body.challenge!, { origin: ORIGIN, rpId: RP_ID });
    expect((await postAdd(forged, { cookie: `${s.cookie}; ${bensOptions.challengeCookie}` })).body).toEqual({ ok: false, error: "rejected" });
    // Asking again with another person's passkey stamps and uses nothing of theirs.
    const benBefore = await sessionsOf(ben.authUserId);
    for (const k of [annKey, benKey]) expect((await passkeyAgain(k, s.cookie)).body).toEqual({ ok: false, error: "rejected" });
    expect(await sessionsOf(ben.authUserId)).toEqual(benBefore);
    const users = db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(inArray(parentAuthUser.parentId, [ann.id, ben.id]));
    const theirs = await db.select().from(parentAuthPasskey).where(and(inArray(parentAuthPasskey.userId, users)));
    expect(theirs.map((r) => [r.name, r.lastUsedAt]).sort()).toEqual([[null, null], [null, null]]);
    expect(theirs).toHaveLength(2);
    expect(await passkeyRows(ana.id)).toEqual([]);
  });

  it("/portal-passkey/again with no session does nothing", async () => {
    const ana = await seedPerson("Ana");
    const k = await seedPasskey(ana.id);
    expect((await passkeyAgain(k, "")).body).toEqual({ ok: false, error: "rejected" });
    expect((await passkeyRows(ana.id))[0]!.lastUsedAt).toBeNull();
    expect(await audits("signin.proved_again")).toEqual([]);
  });
});

describe("what the review of SI-7b found", () => {
  it("a credential the unique index refuses (two adds of it at once, both past the portal's check) is answered as already added", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const key = makePasskeyKey();
    expect((await addPasskey(s.cookie, { key })).body.ok).toBe(true);
    await proveNow(s.sessionId);
    fault.skipTaken = 1;
    expect((await addPasskey(s.cookie, { key })).body).toEqual({ ok: false, error: "already_added" });
    expect(await passkeyRows(ana.id)).toHaveLength(1);
    expect((await audits("parent.passkey.add_refused")).map((a) => a.reason)).toEqual(["already_added"]);
  });

  it("an add whose session's proof ran out between the options and the answer is asked to prove it again, and adds nothing", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const options = await registerOptions({ cookie: s.cookie });
    expect(options.res.status).toBe(200);
    await db.update(parentAuthSession).set({ strongAt: null }).where(eq(parentAuthSession.id, s.sessionId));
    const { registrationFor } = await import("../helpers/passkey-keys");
    const { ORIGIN, RP_ID } = await import("../helpers/passkey");
    const answer = registrationFor(makePasskeyKey(), options.body.challenge!, { origin: ORIGIN, rpId: RP_ID });
    expect((await postAdd(answer, { cookie: [s.cookie, options.challengeCookie].filter(Boolean).join("; ") })).body).toEqual({ ok: false, error: "prove_again" });
    expect(await passkeyRows(ana.id)).toEqual([]);
    expect((await audits("parent.passkey.add_refused")).map((a) => a.reason)).toEqual(["not_allowed"]);
  });

  it("a passkey's first is the one none of theirs was added before, by when it was added and then its id, so two adds at once make one set of codes", async () => {
    const ana = await seedPerson("Ana");
    const at = new Date(Date.now() - 2 * 60 * 60_000);
    const older = await seedPasskey(ana.id, { createdAt: at });
    const twinA = await seedPasskey(ana.id, { createdAt: new Date(at.getTime() + 60_000) });
    const twinB = await seedPasskey(ana.id, { createdAt: new Date(at.getTime() + 60_000) });
    const [low, high] = [twinA.rowId, twinB.rowId].sort();
    expect(await passkeysAddedBefore(db, ana.id, older.rowId)).toBe(0);
    expect(await passkeysAddedBefore(db, ana.id, low!)).toBe(1);
    expect(await passkeysAddedBefore(db, ana.id, high!)).toBe(2);
    // Another person's passkeys never count.
    const ben = await seedPerson("Ben", "F2");
    const bens = await seedPasskey(ben.id, { createdAt: new Date(at.getTime() - 60_000) });
    expect(await passkeysAddedBefore(db, ben.id, bens.rowId)).toBe(0);
    expect(await passkeysAddedBefore(db, ana.id, older.rowId)).toBe(0);
  });

  it("under Strict, two removes of a person's two passkeys at once leave one: they go one at a time, and the second is the last", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const one = await seedPasskey(ana.id);
    const two = await seedPasskey(ana.id);
    await seedParentSettings({ level: "strict" });
    await proveNow(s.sessionId);
    const answers = await Promise.all([removeMyPasskey(s.ctx, one.rowId), removeMyPasskey(s.ctx, two.rowId)]);
    expect(answers.filter((r) => r.ok)).toEqual([{ ok: true, message: COPY.passkeyRemoved }]);
    expect(answers.filter((r) => !r.ok)).toEqual([{ ok: false, errors: [COPY.passkeyRemoveStrict] }]);
    expect(await passkeyRows(ana.id)).toHaveLength(1);
  });

  it("under Standard, two removes at once of a person's two passkeys take the backup codes with the last", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const one = await seedPasskey(ana.id);
    const two = await seedPasskey(ana.id);
    await seedBackupCodes(ana.id);
    await proveNow(s.sessionId);
    const answers = await Promise.all([removeMyPasskey(s.ctx, one.rowId), removeMyPasskey(s.ctx, two.rowId)]);
    expect(answers.map((r) => (r.ok ? r.message : "refused")).sort()).toEqual([COPY.passkeyRemoved, COPY.passkeyRemovedLast].sort());
    expect(await passkeyRows(ana.id)).toEqual([]);
    expect(await backupCodesOf(ana.id)).toEqual([]);
  });

  it("new backup codes are made beside a passkey alone (no app), shown once", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    await seedPasskey(ana.id);
    await seedBackupCodes(ana.id);
    await proveNow(s.sessionId);
    const r = await remakeMyBackupCodes(s.ctx);
    if (!r.ok) throw new Error("new backup codes should be made beside a passkey");
    expect(r.message).toBe(COPY.newCodesMade);
    expect(r.codes).toHaveLength(10);
    expect(await backupCodesOf(ana.id)).toHaveLength(10);
  });

  it("/portal-passkey/again for a blocked person stamps nothing and marks no use", async () => {
    const ana = await seedPerson("Ana");
    const s = await signedIn(ana);
    const k = await seedPasskey(ana.id);
    await db.update(parentAuthSession).set({ strongAt: null }).where(eq(parentAuthSession.id, s.sessionId));
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    expect((await passkeyAgain(k, s.cookie)).body).toEqual({ ok: false, error: "rejected" });
    expect(await audits("signin.proved_again")).toEqual([]);
    expect((await sessionsOf(ana.authUserId)).map((r) => r.strongAt)).toEqual([null]);
    expect((await passkeyRows(ana.id))[0]!.lastUsedAt).toBeNull();
  });
});
