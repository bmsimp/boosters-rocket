import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthSession, parentAuthUser, parentDevice } from "@/lib/db/schema";
import { DEVICE_LIFE_MS, recordStrongSignin } from "@/lib/parents/devices";
import { blockPerson } from "@/lib/parents/people";
import { PARENT_SESSION_SECONDS, renewParentSession } from "@/lib/parents/sessions";
import { resetDb } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedSignedInParent } from "../helpers/parent";
import { deviceRows, seedDevice } from "../helpers/signin-links";

/**
 * A remembered device renewed by use (the sign-in release, slice SI-5b; open question 26): every session names the
 * device it was made on (`parent_auth_session.device_id`, written by a sign-in's strong step), and the session's own
 * renewal, at most once a day, renews that device in the same transaction: only the session's own person's device,
 * unexpired, and never one forgotten (its row gone, the column set null).
 */
const DAY = 86_400_000;
const staff = { actor: { door: "staff" as const, id: null, label: "board" }, ip: null };
beforeEach(async () => { await resetDb(); });

const sessionRow = async (id: string) => (await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, id)))[0];
const deviceRow = async (id: string) => (await db.select().from(parentDevice).where(eq(parentDevice.id, id)))[0];
const nameDevice = (sessionId: string, deviceId: string | null) => db.update(parentAuthSession).set({ deviceId }).where(eq(parentAuthSession.id, sessionId));
/** A device last used ten days ago, its 90 days running from then: due its renewal. */
const tenDaysOld = (parentId: string) => seedDevice(parentId, { createdAt: new Date(Date.now() - 30 * DAY), lastUsedAt: new Date(Date.now() - 10 * DAY), expiresAt: new Date(Date.now() + 80 * DAY) });
/** The session's renewal, as identity.ts calls it, with the expiry the session row holds now. */
async function renew(sessionId: string, now = new Date()) {
  const row = await sessionRow(sessionId);
  return renewParentSession({ id: sessionId, expiresAt: row!.expiresAt }, now);
}

describe("the device a session names", () => {
  it("each proof's session names its device: a new one for a code's sign-in, the remembered one for a device's", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const strong = { parentId: a.identity.parentId, email: a.identity.email, sessionId: a.identity.sessionId, ip: null };
    expect((await sessionRow(a.identity.sessionId))!.deviceId).toBeNull(); // a session from before SI-5b names none
    expect(await recordStrongSignin({ ...strong, device: { remember: true } })).toMatchObject({ ok: true });
    const [made] = await deviceRows(a.identity.parentId);
    expect((await sessionRow(a.identity.sessionId))!.deviceId).toBe(made!.id);
    const remembered = await seedDevice(a.identity.parentId);
    expect(await recordStrongSignin({ ...strong, device: { deviceId: remembered.id, token: remembered.token } })).toMatchObject({ ok: true });
    expect((await sessionRow(a.identity.sessionId))!.deviceId).toBe(remembered.id);
  });

  it("goes on with none once its device is forgotten: the row's delete sets the column null", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const device = await tenDaysOld(a.identity.parentId);
    await nameDevice(a.identity.sessionId, device.id);
    await db.delete(parentDevice).where(eq(parentDevice.id, device.id));
    const row = await sessionRow(a.identity.sessionId);
    expect(row).toBeDefined();
    expect(row!.deviceId).toBeNull();
    // Its renewal renews the session alone, and brings no device back.
    expect(await renew(a.identity.sessionId)).toBe(true);
    expect(await deviceRows(a.identity.parentId)).toEqual([]);
  });
});

describe("renewal by use", () => {
  it("a session due its renewal renews the device it names, in the same transaction, by the device's own life", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const device = await tenDaysOld(a.identity.parentId);
    const created = (await deviceRow(device.id))!.createdAt;
    await nameDevice(a.identity.sessionId, device.id);
    const now = new Date();
    expect(await renew(a.identity.sessionId, now)).toBe(true);
    const renewed = (await deviceRow(device.id))!;
    expect(renewed.lastUsedAt.getTime()).toBe(now.getTime());
    expect(renewed.expiresAt.getTime()).toBe(now.getTime() + DEVICE_LIFE_MS);
    expect(renewed.createdAt.getTime()).toBe(created.getTime());
    expect((await sessionRow(a.identity.sessionId))!.expiresAt.getTime()).toBe(now.getTime() + PARENT_SESSION_SECONDS * 1000);
  });

  it("does not renew another person's device, even when the session's column names it", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    const theirs = await tenDaysOld(b.identity.parentId);
    const before = await deviceRow(theirs.id);
    await nameDevice(a.identity.sessionId, theirs.id); // set by hand: nothing in the portal writes another person's
    expect(await renew(a.identity.sessionId)).toBe(true); // the session is still renewed
    expect(await deviceRow(theirs.id)).toEqual(before);
  });

  it("does not bring an expired device back", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const expired = await seedDevice(a.identity.parentId, { lastUsedAt: new Date(Date.now() - 91 * DAY), expiresAt: new Date(Date.now() - 1000) });
    const before = await deviceRow(expired.id);
    await nameDevice(a.identity.sessionId, expired.id);
    expect(await renew(a.identity.sessionId)).toBe(true);
    expect(await deviceRow(expired.id)).toEqual(before);
  });

  it("writes nothing when the session isn't due its renewal (renewed less than a day ago)", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const device = await tenDaysOld(a.identity.parentId);
    await nameDevice(a.identity.sessionId, device.id);
    await db.update(parentAuthSession).set({ expiresAt: new Date(Date.now() + PARENT_SESSION_SECONDS * 1000 - DAY / 2) }).where(eq(parentAuthSession.id, a.identity.sessionId));
    const before = { session: await sessionRow(a.identity.sessionId), device: await deviceRow(device.id) };
    expect(await renew(a.identity.sessionId)).toBe(false);
    expect({ session: await sessionRow(a.identity.sessionId), device: await deviceRow(device.id) }).toEqual(before);
  });

  it("two renewals at once renew once: the session and its device by the one that went first", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const device = await tenDaysOld(a.identity.parentId);
    await nameDevice(a.identity.sessionId, device.id);
    const { expiresAt } = (await sessionRow(a.identity.sessionId))!;
    const first = new Date();
    const second = new Date(first.getTime() + 1000);
    const answers = await Promise.all([first, second].map((now) => renewParentSession({ id: a.identity.sessionId, expiresAt }, now)));
    expect([...answers].sort()).toEqual([false, true]);
    const won = answers[0] ? first : second;
    const renewed = (await deviceRow(device.id))!;
    expect(renewed.lastUsedAt.getTime()).toBe(won.getTime());
    expect(renewed.expiresAt.getTime()).toBe(won.getTime() + DEVICE_LIFE_MS);
    expect((await sessionRow(a.identity.sessionId))!.expiresAt.getTime()).toBe(won.getTime() + PARENT_SESSION_SECONDS * 1000);
  });

  it("a block racing a renewal ends with no device and no session of the person", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const device = await tenDaysOld(a.identity.parentId);
    await nameDevice(a.identity.sessionId, device.id);
    const { expiresAt } = (await sessionRow(a.identity.sessionId))!;
    const [blocked] = await Promise.all([
      blockPerson(a.identity.parentId, "a reason staff wrote", staff),
      renewParentSession({ id: a.identity.sessionId, expiresAt }),
    ]);
    expect(blocked).toMatchObject({ ok: true });
    expect(await deviceRows(a.identity.parentId)).toEqual([]);
    const [user] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, a.identity.parentId));
    expect(await db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, user!.id))).toEqual([]);
  });
});
