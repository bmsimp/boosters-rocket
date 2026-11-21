import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthPasskey, parentAuthSession } from "@/lib/db/schema";
import { oldAddressPasskeys, removeOldAddressPasskeys } from "@/lib/parents/signin-reset";
import { PARENTS_KEY } from "@/lib/parents/settings";
import { resetDb, seedGuardianInFamily, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_PASSWORD, passwordStep } from "../helpers/parent-door";
import { seedPassword } from "../helpers/signin-links";
import { authenticatorRows, backupCodeRows, seedAuthenticator, seedBackupCodes } from "../helpers/authenticator";
import { ORIGIN, passkeyRows, seedPasskey } from "../helpers/passkey";
import { ADD_UNDER_WAY_MINUTES, removePasskey } from "@/lib/parents/passkeys";

/**
 * Passkeys from an earlier address of the portal (the sign-in release, slice SI-9b): the count an Admin is shown, and
 * their press that removes every passkey whose recorded origin isn't the portal's now (ORIGIN, the test's APP_URL),
 * a null one included, with the backup codes left standing beside nothing and, at Strict, the sessions of those left
 * with no second factor; then the way back in for each, through the door's own functions. The section on Settings,
 * Parent sign-ins and its action are tests/integration/settings-parents.test.ts's; the Health note health-page.test.ts's.
 */
const IP = "203.0.113.72";
const ADMIN = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-0000000000ad", label: "ada@club.org" }, ip: IP, permission: "Parents.SignInReset.ReadWrite" };
const OLD = "https://old.example.org";
const OLDER = "https://older.example.org";

const auditsOf = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const removedRowOf = async (parentId: string) => (await db.select().from(auditLog)
  .where(and(eq(auditLog.action, "parent.passkey.remove"), eq(auditLog.targetType, "parent"), eq(auditLog.targetId, parentId))));
const sessionsOf = (authUserId: string) => db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));
const originsOf = async (parentId: string) => (await passkeyRows(parentId)).map((r) => r.origin);

/** A guardian of a family of the app's own, with a password. */
async function seedGuardianNamed(name: string, familyQboId: string) {
  const p = await seedParent({ name, email: `${name.toLowerCase()}@example.com` });
  await seedGuardianInFamily({ parentId: p.id, familyQboId });
  await seedPassword(p.authUserId, DOOR_PASSWORD);
  return p;
}

/**
 * The club after a change of address: Ana holds only passkeys from earlier addresses (two at OLD and one the portal
 * never recorded) and backup codes; Ben one at OLDER beside a current one, and codes; Cal one at OLD beside an app,
 * and its codes; Dee, blocked, one at OLD and codes; Eve only a current one. Each has a session.
 */
async function seedClub() {
  const ana = await seedGuardianNamed("Ana", "F1");
  const ben = await seedGuardianNamed("Ben", "F2");
  const cal = await seedGuardianNamed("Cal", "F3");
  const dee = await seedGuardianNamed("Dee", "F4");
  const eve = await seedGuardianNamed("Eve", "F5");
  const keys = [
    await seedPasskey(ana.id, { origin: OLD }), await seedPasskey(ana.id, { origin: OLD }), await seedPasskey(ana.id, { origin: null }),
    await seedPasskey(ben.id, { origin: OLDER }), await seedPasskey(ben.id),
    await seedPasskey(cal.id, { origin: OLD }),
    await seedPasskey(dee.id, { origin: OLD }),
    await seedPasskey(eve.id),
  ];
  // Names the parents gave their passkeys: never in an audit row.
  await db.update(parentAuthPasskey).set({ name: "Ana's phone" }).where(eq(parentAuthPasskey.id, keys[0]!.rowId));
  await seedAuthenticator(cal.id);
  for (const p of [ana, ben, cal, dee]) await seedBackupCodes(p.id);
  for (const p of [ana, ben, cal, dee, eve]) await seedParentSession(p.authUserId);
  await db.update(parent).set({ blocked: true }).where(eq(parent.id, dee.id));
  return { ana, ben, cal, dee, eve, keys };
}

beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

describe("the count of passkeys from an earlier address", () => {
  it("is none when every passkey was made at the portal's address now", async () => {
    const eve = await seedGuardianNamed("Eve", "F1");
    await seedPasskey(eve.id);
    expect(await oldAddressPasskeys()).toEqual({ origin: ORIGIN, passkeys: 0, people: 0, leftWithNoFactor: 0, byOrigin: [] });
  });

  it("counts them by the origin they were made at, a null one its own, the people, and those the press would leave with neither (a blocked person not among them)", async () => {
    await seedClub();
    expect(await oldAddressPasskeys()).toEqual({ origin: ORIGIN, passkeys: 6, people: 4, leftWithNoFactor: 1,
      byOrigin: [{ origin: OLD, passkeys: 4 }, { origin: OLDER, passkeys: 1 }, { origin: null, passkeys: 1 }] });
  });
});

describe("an Admin's removal of every passkey from an earlier address", () => {
  it("at Standard removes only those, null ones included, takes the codes of the one left with nothing, signs nobody out, and audits each person and the whole", async () => {
    const { ana, ben, cal, dee, eve, keys } = await seedClub();
    expect(await removeOldAddressPasskeys(6, ADMIN)).toEqual({ ok: true, passkeys: 6, people: 4, leftWithNoFactor: 1, signedOut: 0 });
    expect(await originsOf(ana.id)).toEqual([]);
    expect(await originsOf(ben.id)).toEqual([ORIGIN]);
    expect(await originsOf(cal.id)).toEqual([]);
    expect(await originsOf(dee.id)).toEqual([]);
    expect(await originsOf(eve.id)).toEqual([ORIGIN]);
    // Codes go only for Ana, left with no passkey and no app; beside Ben's current passkey and Cal's app they stay, and
    // a blocked person keeps everything but their old passkeys.
    expect((await backupCodeRows(ana.id)).length).toBe(0);
    for (const p of [ben, cal, dee]) expect((await backupCodeRows(p.id)).length).toBe(10);
    expect(await authenticatorRows(cal.id)).toHaveLength(1);
    expect((await db.select({ blocked: parent.blocked }).from(parent).where(eq(parent.id, dee.id)))[0]!.blocked).toBe(true);
    for (const p of [ana, ben, cal, dee, eve]) expect(await sessionsOf(p.authUserId)).toHaveLength(1);

    const rowOf = async (p: { id: string }) => { const rows = await removedRowOf(p.id); expect(rows).toHaveLength(1); return rows[0]!; };
    const anaRow = await rowOf(ana);
    expect([anaRow.actorId, anaRow.permission, anaRow.door]).toEqual([ADMIN.actor.id, "Parents.SignInReset.ReadWrite", "staff"]);
    expect(anaRow.after).toEqual({ reason: "old_address", removed: 3, passkeys: 0, backupCodesDeleted: 10, sessionsEnded: 0 });
    expect((await rowOf(ben)).after).toEqual({ reason: "old_address", removed: 1, passkeys: 1, backupCodesDeleted: 0, sessionsEnded: 0 });
    expect((await rowOf(cal)).after).toEqual({ reason: "old_address", removed: 1, passkeys: 0, backupCodesDeleted: 0, sessionsEnded: 0 });
    expect((await rowOf(dee)).after).toEqual({ reason: "old_address", removed: 1, passkeys: 0, backupCodesDeleted: 0, sessionsEnded: 0 });
    expect(await removedRowOf(eve.id)).toEqual([]);

    const whole = await auditsOf("parent.passkeys.old_address_removed");
    expect(whole).toHaveLength(1);
    expect([whole[0]!.targetType, whole[0]!.targetId, whole[0]!.permission]).toEqual(["setting", PARENTS_KEY, "Parents.SignInReset.ReadWrite"]);
    expect(whole[0]!.after).toEqual({ origin: ORIGIN, level: "standard", passkeys: 6, people: 4, backupCodesDeleted: 10, leftWithNoFactor: 1, sessionsEnded: 0,
      byOrigin: [{ origin: OLD, passkeys: 4 }, { origin: OLDER, passkeys: 1 }, { origin: null, passkeys: 1 }] });
    // Counts only: no credential id and no passkey's name in any row the press wrote.
    const written = JSON.stringify(await db.select().from(auditLog).where(inArray(auditLog.action, ["parent.passkey.remove", "parent.passkeys.old_address_removed"])));
    for (const k of keys) expect(written).not.toContain(k.id);
    expect(written).not.toContain("Ana's phone");
    // Nobody is mailed.
    expect(outbox).toEqual([]);
    // A second press finds none.
    expect(await removeOldAddressPasskeys(6, ADMIN)).toEqual({ ok: false, reason: "none" });
  });

  it("at Strict ends every session of a person left with neither, and keeps the sessions of one with an app", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" });
    const ana = await seedGuardianNamed("Ana", "F1");
    const cal = await seedGuardianNamed("Cal", "F2");
    await seedPasskey(ana.id, { origin: OLD });
    await seedPasskey(cal.id, { origin: OLD });
    await seedAuthenticator(cal.id);
    await seedBackupCodes(ana.id); await seedBackupCodes(cal.id);
    await seedParentSession(ana.authUserId); await seedParentSession(ana.authUserId);
    await seedParentSession(cal.authUserId);
    expect(await oldAddressPasskeys()).toMatchObject({ passkeys: 2, people: 2, leftWithNoFactor: 1 });
    expect(await removeOldAddressPasskeys(2, ADMIN)).toEqual({ ok: true, passkeys: 2, people: 2, leftWithNoFactor: 1, signedOut: 1 });
    expect(await sessionsOf(ana.authUserId)).toEqual([]);
    expect(await sessionsOf(cal.authUserId)).toHaveLength(1);
    expect((await backupCodeRows(cal.id)).length).toBe(10);
    expect((await removedRowOf(ana.id))[0]!.after).toEqual({ reason: "old_address", removed: 1, passkeys: 0, backupCodesDeleted: 10, sessionsEnded: 2 });
    expect((await auditsOf("parent.passkeys.old_address_removed"))[0]!.after).toMatchObject({ level: "strict", sessionsEnded: 2, leftWithNoFactor: 1 });
  });

  it("at Strict keeps the sessions and codes of a holder of a current passkey, and a blocked holder's codes", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" });
    const ben = await seedGuardianNamed("Ben", "F1");
    const dee = await seedGuardianNamed("Dee", "F2");
    await seedPasskey(ben.id, { origin: OLD }); await seedPasskey(ben.id);
    await seedPasskey(dee.id, { origin: OLD });
    await seedBackupCodes(ben.id); await seedBackupCodes(dee.id);
    await seedParentSession(ben.authUserId);
    // A blocked person's sessions were ended by the block; one seeded here stands for any the press might wrongly take.
    await seedParentSession(dee.authUserId);
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, dee.id));
    expect(await oldAddressPasskeys()).toMatchObject({ passkeys: 2, people: 2, leftWithNoFactor: 0 });
    expect(await removeOldAddressPasskeys(2, ADMIN)).toEqual({ ok: true, passkeys: 2, people: 2, leftWithNoFactor: 0, signedOut: 0 });
    expect(await originsOf(ben.id)).toEqual([ORIGIN]);
    expect(await originsOf(dee.id)).toEqual([]);
    for (const p of [ben, dee]) {
      expect(await sessionsOf(p.authUserId)).toHaveLength(1);
      expect((await backupCodeRows(p.id)).length).toBe(10);
      expect((await removedRowOf(p.id))[0]!.after).toMatchObject({ backupCodesDeleted: 0, sessionsEnded: 0 });
    }
  });

  it("neither counts nor removes a row with no origin young enough to be an add under way, and takes one older", async () => {
    const ana = await seedGuardianNamed("Ana", "F1");
    const ben = await seedGuardianNamed("Ben", "F2");
    // Ana's add is under way: the library inserted the row a moment ago and the add hasn't recorded its origin yet.
    const adding = await seedPasskey(ana.id, { origin: null, createdAt: new Date() });
    await seedBackupCodes(ana.id);
    // Ben's row was never recorded, and is older than any add could still be.
    await seedPasskey(ben.id, { origin: null, createdAt: new Date(Date.now() - (ADD_UNDER_WAY_MINUTES + 1) * 60_000) });
    await seedPasskey(ana.id, { origin: OLD });
    // Ana keeps a passkey (the one being added), so she isn't left with nothing.
    expect(await oldAddressPasskeys()).toMatchObject({ passkeys: 2, people: 2, leftWithNoFactor: 1, byOrigin: [{ origin: OLD, passkeys: 1 }, { origin: null, passkeys: 1 }] });
    expect(await removeOldAddressPasskeys(2, ADMIN)).toEqual({ ok: true, passkeys: 2, people: 2, leftWithNoFactor: 1, signedOut: 0 });
    expect((await passkeyRows(ana.id)).map((r) => r.id)).toEqual([adding.rowId]);
    expect((await backupCodeRows(ana.id)).length).toBe(10);
    expect(await passkeyRows(ben.id)).toEqual([]);
  });

  it("works with sign-ins off", async () => {
    await seedParentSettings({ signin: false });
    const ana = await seedGuardianNamed("Ana", "F1");
    await seedPasskey(ana.id, { origin: null });
    expect(await removeOldAddressPasskeys(1, ADMIN)).toMatchObject({ ok: true, passkeys: 1 });
    expect(await passkeyRows(ana.id)).toEqual([]);
  });
});

describe("what the press refuses", () => {
  it("a count that is no longer the count: changing nothing, with the refused row", async () => {
    const { ana, keys } = await seedClub();
    const before = await passkeyRows(ana.id);
    expect(await removeOldAddressPasskeys(5, ADMIN)).toEqual({ ok: false, reason: "count_changed" });
    expect(await passkeyRows(ana.id)).toEqual(before);
    expect((await backupCodeRows(ana.id)).length).toBe(10);
    const refused = await auditsOf("parent.passkeys.old_address_refused");
    expect(refused.map((r) => [r.targetType, r.targetId, r.after])).toEqual([["setting", PARENTS_KEY, { reason: "count_changed", shown: 5, found: 6 }]]);
    const written = JSON.stringify(refused);
    for (const k of keys) expect(written).not.toContain(k.id);
    expect(written).not.toContain("Ana's phone");
    expect(await auditsOf("parent.passkey.remove")).toEqual([]);
    expect(await auditsOf("parent.passkeys.old_address_removed")).toEqual([]);
  });

  it("none to remove: writing nothing", async () => {
    const eve = await seedGuardianNamed("Eve", "F1");
    await seedPasskey(eve.id);
    expect(await removeOldAddressPasskeys(1, ADMIN)).toEqual({ ok: false, reason: "none" });
    expect(await originsOf(eve.id)).toEqual([ORIGIN]);
    expect(await db.select().from(auditLog).where(inArray(auditLog.action, ["parent.passkeys.old_address_refused", "parent.passkeys.old_address_removed", "parent.passkey.remove"]))).toEqual([]);
  });

  it("anything but a whole number of one or more, reading and writing nothing", async () => {
    const ana = await seedGuardianNamed("Ana", "F1");
    await seedPasskey(ana.id, { origin: OLD });
    for (const shown of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "1", null, undefined, {}]) {
      expect(await removeOldAddressPasskeys(shown, ADMIN)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await passkeyRows(ana.id)).toHaveLength(1);
    expect(await auditsOf("parent.passkeys.old_address_refused")).toEqual([]);
  });

  it("two presses at once remove each passkey once: one does it, the other finds none", async () => {
    const { ana, ben, cal, dee } = await seedClub();
    const answers = await Promise.all([removeOldAddressPasskeys(6, ADMIN), removeOldAddressPasskeys(6, ADMIN)]);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.find((a) => !a.ok)).toEqual({ ok: false, reason: "none" });
    for (const p of [ana, ben, cal, dee]) expect(await removedRowOf(p.id)).toHaveLength(1);
    expect(await auditsOf("parent.passkeys.old_address_removed")).toHaveLength(1);
  });
});

describe("a press beside one person's own write", () => {
  it("waits for a person's own passkey remove under their row, then counts what it finds, with no deadlock", async () => {
    const { ana, ben, cal, dee, keys } = await seedClub();
    // Ben removes his current passkey in sign-in settings (removeMyPasskey() holds his row FOR UPDATE, as here) while an
    // Admin presses: the press waits for his row, and finds him with only the old one, so his codes go with it.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const own = db.transaction(async (tx) => {
      await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ben.id)).for("update");
      locked();
      await held;
      expect(await removePasskey(tx, ben.id, keys[4]!.rowId)).toBe(true);
    });
    await isLocked;
    const press = removeOldAddressPasskeys(6, ADMIN);
    await new Promise((r) => setTimeout(r, 200));
    release();
    const [, answer] = await Promise.all([own, press]);
    expect(answer).toEqual({ ok: true, passkeys: 6, people: 4, leftWithNoFactor: 2, signedOut: 0 });
    expect(await passkeyRows(ben.id)).toEqual([]);
    expect((await backupCodeRows(ben.id)).length).toBe(0);
    for (const p of [ana, ben, cal, dee]) expect(await removedRowOf(p.id)).toHaveLength(1);
  });
});

describe("the way back in after the press, through the door", () => {
  it("at Standard a holder of only old passkeys is asked for the emailed code, and an app's holder for the app", async () => {
    const ana = await seedGuardianNamed("Ana", "F1");
    const cal = await seedGuardianNamed("Cal", "F2");
    await seedPasskey(ana.id, { origin: OLD });
    await seedPasskey(cal.id, { origin: OLD });
    await seedAuthenticator(cal.id);
    // Before the press the portal still asks each of them for the passkey that can't work here.
    expect((await passwordStep(ana.email)).body).toEqual({ ok: true, step: "passkey", app: false });
    expect((await removeOldAddressPasskeys(2, ADMIN)).ok).toBe(true);
    expect((await passwordStep(ana.email)).body).toEqual({ ok: true, step: "code" });
    expect((await passwordStep(cal.email)).body).toEqual({ ok: true, step: "app" });
  });

  it("at Strict a holder of only old passkeys is led to add a second factor, and an app's holder is asked for the app", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" });
    const ana = await seedGuardianNamed("Ana", "F1");
    const cal = await seedGuardianNamed("Cal", "F2");
    await seedPasskey(ana.id, { origin: OLD });
    await seedPasskey(cal.id, { origin: OLD });
    await seedAuthenticator(cal.id);
    expect((await removeOldAddressPasskeys(2, ADMIN)).ok).toBe(true);
    expect((await passwordStep(ana.email)).body).toEqual({ ok: true, next: "/one-more-step" });
    expect((await passwordStep(cal.email)).body).toEqual({ ok: true, step: "app" });
  });

  it("a holder of a passkey made at the new address keeps it, and its backup codes, and is asked for it", async () => {
    const ben = await seedGuardianNamed("Ben", "F1");
    await seedPasskey(ben.id, { origin: OLD });
    await seedPasskey(ben.id);
    await seedBackupCodes(ben.id);
    expect((await removeOldAddressPasskeys(1, ADMIN)).ok).toBe(true);
    expect((await passwordStep(ben.email)).body).toEqual({ ok: true, step: "passkey", app: false, backup: true });
  });
});
