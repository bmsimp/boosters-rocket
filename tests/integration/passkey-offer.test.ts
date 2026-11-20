import { describe, it, expect, vi, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// The reset (SI-9a) mails its set-up link: an outbox.
type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// Home shows what the family owes; nothing here is connected to QuickBooks, and nothing may ever reach Intuit.
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: "http://127.0.0.1:9/authorize", token: "http://127.0.0.1:9/token", revoke: "http://127.0.0.1:9/revoke",
    api: { sandbox: "http://127.0.0.1:9", production: "http://127.0.0.1:9" } }) };
});
// The box is a client component that draws nothing until it has read the browser, so the server's HTML holds nothing
// of it. Home's choice to draw it, and every prop it is given (each is sent to the browser), are read here instead.
const drawn = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/app/(parent)/passkey-offer", () => ({ PasskeyOffer: (props: Record<string, unknown>) => { drawn.props.push(props); return null; } }));

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthAccount, parentAuthSession, parentAuthUser, parentDevice } from "@/lib/db/schema";
import { env } from "@/env";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { declinePasskeyOffer, passkeyOfferFor } from "@/lib/parents/passkey-offer";
import { PASSKEY_OFFER_COPY as WORDS } from "@/lib/parents/passkey-offer-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { resetSignin } from "@/lib/parents/signin-reset";
import ParentHome from "@/app/(parent)/page";
import { declinePasskeyOfferAction } from "@/app/(parent)/passkey-offer-actions";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, PROVEN_PASSWORD, seedParentIn, seedSignedInParent } from "../helpers/parent";
import { seedParentSettings } from "../helpers/roster-cache";
import { deviceRows, seedDevice, seedPassword } from "../helpers/signin-links";
import { seedAuthenticator } from "../helpers/authenticator";
import { seedPasskey } from "../helpers/passkey";

/**
 * The passkey offer on Home (the sign-in release, slice SI-8; open question 31): drawn only for a session made in the
 * last 10 minutes by a sign-in that proved the password and a second step, of a person who may add a passkey with one
 * tap and holds none, on a device of theirs with no "Not now" in the last 30 days, who has said "Not now" fewer than
 * three times; given only APP_URL's origin. "Not now" stamps the session's device and counts against the person once
 * per offer, and touches no one else's.
 */
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ago = (ms: number) => new Date(Date.now() - ms);
const ORIGIN = new URL(env.APP_URL).origin;
const ADMIN = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-0000000000ad", label: "ada@club.org" }, ip: "203.0.113.71", permission: "Parents.SignInReset.ReadWrite" };

async function authUserOf(parentId: string): Promise<string> {
  const [u] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId));
  if (!u) throw new Error("the person has no sign-in account");
  return u.id;
}

/**
 * The session as a sign-in left it, by the test's own clock (the database's may run a little ahead): made a minute ago
 * and proved then, on a new device of the person's that names no "Not now", with a password chosen an hour before.
 * Each part can be changed: when it was made, its proof (null for a password on a remembered device), its device
 * (none, or one stamped), and no password at all.
 */
async function signedInJustNow(identity: ParentIdentity, o: { madeAt?: Date; strongAt?: Date | null; device?: "none" | { offeredAt: Date }; password?: false } = {}) {
  const userId = await authUserOf(identity.parentId);
  const hasPassword = (await db.select({ id: parentAuthAccount.id }).from(parentAuthAccount)
    .where(and(eq(parentAuthAccount.userId, userId), eq(parentAuthAccount.providerId, "credential")))).length > 0;
  if (o.password !== false && !hasPassword) await seedPassword(userId, PROVEN_PASSWORD, ago(60 * MINUTE));
  let deviceId: string | null = null;
  if (o.device !== "none") {
    deviceId = (await seedDevice(identity.parentId)).id;
    if (o.device) await db.update(parentDevice).set({ passkeyOfferedAt: o.device.offeredAt }).where(eq(parentDevice.id, deviceId));
  }
  await db.update(parentAuthSession).set({ createdAt: o.madeAt ?? ago(MINUTE), strongAt: o.strongAt === undefined ? ago(MINUTE) : o.strongAt, deviceId })
    .where(eq(parentAuthSession.id, identity.sessionId));
  return { deviceId };
}

/** Whether Home drew the box for this parent, checking every prop it was given. */
async function offeredOnHome(identity: ParentIdentity): Promise<boolean> {
  drawn.props.length = 0;
  asParent(identity);
  await renderPage(ParentHome);
  for (const props of drawn.props) expect(props).toEqual({ portalOrigin: ORIGIN });
  return drawn.props.length > 0;
}

const declinesOf = async (parentId: string) => (await db.select({ n: parent.passkeyOfferDeclines }).from(parent).where(eq(parent.id, parentId)))[0]?.n;
const stampOf = async (deviceId: string) => (await db.select({ at: parentDevice.passkeyOfferedAt }).from(parentDevice).where(eq(parentDevice.id, deviceId)))[0]?.at ?? null;

beforeEach(async () => { await resetDb(); outbox.length = 0; drawn.props.length = 0; });

describe("who Home offers a passkey", () => {
  it("draws the box, given only the portal's origin, for a fresh, proved session of a person with a password and no passkey", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    expect(await offeredOnHome(a.identity)).toBe(true);
    expect(drawn.props).toEqual([{ portalOrigin: ORIGIN }]);
    // Drawing writes nothing.
    expect(await declinesOf(a.identity.parentId)).toBe(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "parent.passkey.add"))).toEqual([]);
  });

  it("draws nothing for a session made eleven minutes ago", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { madeAt: ago(11 * MINUTE), strongAt: ago(11 * MINUTE) });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing for a session with no proof: a password on a remembered device", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { strongAt: null });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing for a session made an hour ago that asked again just now", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { madeAt: ago(60 * MINUTE), strongAt: ago(MINUTE) });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing for a session made five minutes ago by the password alone that asked again two minutes ago", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { madeAt: ago(5 * MINUTE), strongAt: ago(2 * MINUTE) });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing for a fresh session whose proof is past the window", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { madeAt: ago(MINUTE), strongAt: ago(11 * MINUTE) });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing when an authenticator app came into force after the sign-in's proof", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    await seedAuthenticator(a.identity.parentId, { createdAt: ago(MINUTE / 2) });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing when the session's device has run out, or is another person's", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await signedInJustNow(a.identity);
    const expired = await seedDevice(a.identity.parentId, { expiresAt: ago(MINUTE) });
    await db.update(parentAuthSession).set({ deviceId: expired.id }).where(eq(parentAuthSession.id, a.identity.sessionId));
    expect(await offeredOnHome(a.identity)).toBe(false);
    const theirs = await seedDevice(b.identity.parentId);
    await db.update(parentAuthSession).set({ deviceId: theirs.id }).where(eq(parentAuthSession.id, a.identity.sessionId));
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing for a person with no password", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { password: false });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing for a person who holds a passkey", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    await seedPasskey(a.identity.parentId, { createdAt: ago(2 * DAY) });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws nothing on a device whose Not now was 29 days ago, and draws it at 30", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { device: { offeredAt: ago(29 * DAY) } });
    expect(await offeredOnHome(a.identity)).toBe(false);
    await signedInJustNow(a.identity, { device: { offeredAt: ago(30 * DAY) } });
    expect(await offeredOnHome(a.identity)).toBe(true);
  });

  it("draws nothing after the third Not now", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    await db.update(parent).set({ passkeyOfferDeclines: 3 }).where(eq(parent.id, a.identity.parentId));
    expect(await offeredOnHome(a.identity)).toBe(false);
    await db.update(parent).set({ passkeyOfferDeclines: 2 }).where(eq(parent.id, a.identity.parentId));
    expect(await offeredOnHome(a.identity)).toBe(true);
  });

  it("draws nothing with sign-ins off", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    await seedParentSettings({ signin: false });
    expect(await offeredOnHome(a.identity)).toBe(false);
    expect(await passkeyOfferFor(a.identity)).toEqual({ offered: false });
  });

  it("draws nothing for a blocked person", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.identity.parentId));
    expect(await passkeyOfferFor(a.identity)).toEqual({ offered: false });
  });

  it("draws nothing when the session names no device", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity, { device: "none" });
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("draws it under Strict for an authenticator app's holder", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedAuthenticator(a.identity.parentId);
    await signedInJustNow(a.identity);
    await seedParentSettings({ level: "strict" });
    expect(await offeredOnHome(a.identity)).toBe(true);
  });

  it("answers with nothing but whether to draw it and the origin", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    expect(await passkeyOfferFor(a.identity)).toEqual({ offered: true, portalOrigin: ORIGIN });
  });
});

describe("Not now", () => {
  it("stamps the session's device and counts once, for two presses at once and one after", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { deviceId } = await signedInJustNow(a.identity);
    asParent(a.identity);
    const audits = (await db.select().from(auditLog)).length;
    const answers = await Promise.all([declinePasskeyOfferAction(), declinePasskeyOfferAction()]);
    expect(answers).toEqual([{ ok: true, message: WORDS.declined }, { ok: true, message: WORDS.declined }]);
    expect(await declinesOf(a.identity.parentId)).toBe(1);
    const stamp = await stampOf(deviceId!);
    expect(stamp).not.toBeNull();
    expect(await declinePasskeyOfferAction()).toEqual({ ok: true, message: WORDS.declined });
    expect(await declinesOf(a.identity.parentId)).toBe(1);
    expect(await stampOf(deviceId!)).toEqual(stamp);
    // Unaudited (NOT_AUDITED): it grants and removes nothing.
    expect((await db.select().from(auditLog)).length).toBe(audits);
    // And the box is not drawn again on that device.
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("says, at the third, that Home won't ask again", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await signedInJustNow(a.identity);
    await db.update(parent).set({ passkeyOfferDeclines: 2 }).where(eq(parent.id, a.identity.parentId));
    asParent(a.identity);
    expect(await declinePasskeyOfferAction()).toEqual({ ok: true, message: WORDS.declinedLast, last: true });
    expect(await declinesOf(a.identity.parentId)).toBe(3);
    // A new sign-in on a new device: still not drawn, on any device ("only in settings").
    await signedInJustNow(a.identity);
    expect(await offeredOnHome(a.identity)).toBe(false);
  });

  it("changes nothing for a session whose offer is not due", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { deviceId } = await signedInJustNow(a.identity, { strongAt: null });
    asParent(a.identity);
    expect(await declinePasskeyOfferAction()).toEqual({ ok: true, message: WORDS.declined });
    expect(await declinesOf(a.identity.parentId)).toBe(0);
    expect(await stampOf(deviceId!)).toBeNull();
  });

  it("keeps a Not now pressed twelve minutes after signing in, the box still on screen", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { deviceId } = await signedInJustNow(a.identity, { madeAt: ago(12 * MINUTE), strongAt: ago(12 * MINUTE) });
    asParent(a.identity);
    expect(await declinePasskeyOfferAction()).toEqual({ ok: true, message: WORDS.declined });
    expect(await declinesOf(a.identity.parentId)).toBe(1);
    expect(await stampOf(deviceId!)).not.toBeNull();
  });

  it("says Home won't ask again to a press after the third, counting nothing more", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { deviceId } = await signedInJustNow(a.identity);
    await db.update(parent).set({ passkeyOfferDeclines: 3 }).where(eq(parent.id, a.identity.parentId));
    asParent(a.identity);
    expect(await declinePasskeyOfferAction()).toEqual({ ok: true, message: WORDS.declinedLast, last: true });
    expect(await declinesOf(a.identity.parentId)).toBe(3);
    expect(await stampOf(deviceId!)).toBeNull();
  });

  it("changes nothing for a blocked person", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { deviceId } = await signedInJustNow(a.identity);
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.identity.parentId));
    expect(await declinePasskeyOffer(a.identity)).toEqual({ ok: true, message: WORDS.declined });
    expect(await declinesOf(a.identity.parentId)).toBe(0);
    expect(await stampOf(deviceId!)).toBeNull();
  });

  it("stamps no device that has run out, nor another person's the session names, and counts nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await signedInJustNow(a.identity);
    const expired = await seedDevice(a.identity.parentId, { expiresAt: ago(MINUTE) });
    const theirs = await seedDevice(b.identity.parentId);
    asParent(a.identity);
    for (const device of [expired.id, theirs.id]) {
      await db.update(parentAuthSession).set({ deviceId: device }).where(eq(parentAuthSession.id, a.identity.sessionId));
      expect(await declinePasskeyOfferAction()).toEqual({ ok: true, message: WORDS.declined });
      expect(await stampOf(device)).toBeNull();
    }
    expect(await declinesOf(a.identity.parentId)).toBe(0);
    expect(await declinesOf(b.identity.parentId)).toBe(0);
  });

  it("is refused over the settings' limit, changing nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { deviceId } = await signedInJustNow(a.identity);
    for (let i = 0; i < 10; i++) await takeRateLimit("signin_settings_parent", a.identity.parentId);
    asParent(a.identity);
    expect(await declinePasskeyOfferAction()).toEqual({ ok: false, errors: [COPY.tooManyPresses] });
    expect(await declinesOf(a.identity.parentId)).toBe(0);
    expect(await stampOf(deviceId!)).toBeNull();
  });

  it("touches no other family's parent, and no other guardian of the same family", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    const second = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Quill Secondguardian", email: "quill.secondguardian@example.org" });
    const aDevice = (await signedInJustNow(a.identity)).deviceId!;
    const bDevice = (await signedInJustNow(b.identity)).deviceId!;
    const secondDevice = (await signedInJustNow(second.identity)).deviceId!;
    asParent(a.identity);
    expect((await declinePasskeyOfferAction()).ok).toBe(true);
    expect(await declinesOf(a.identity.parentId)).toBe(1);
    expect(await stampOf(aDevice)).not.toBeNull();
    for (const [person, device] of [[b.identity.parentId, bDevice], [second.identity.parentId, secondDevice]] as const) {
      expect(await declinesOf(person)).toBe(0);
      expect(await stampOf(device)).toBeNull();
    }
    asParent(second.identity);
    expect((await declinePasskeyOfferAction()).ok).toBe(true);
    expect(await declinesOf(second.identity.parentId)).toBe(1);
    expect(await stampOf(secondDevice)).not.toBeNull();
    expect(await declinesOf(a.identity.parentId)).toBe(1);
    expect(await declinesOf(b.identity.parentId)).toBe(0);
    expect(await stampOf(bDevice)).toBeNull();
  });

  it("a staff reset keeps the count and forgets the stamp with the devices", async () => {
    await seedWorkingMail();
    const a = await seedSignedInParent(FAMILY_A);
    const { deviceId } = await signedInJustNow(a.identity);
    asParent(a.identity);
    expect((await declinePasskeyOfferAction()).ok).toBe(true);
    expect(await declinesOf(a.identity.parentId)).toBe(1);
    expect(await stampOf(deviceId!)).not.toBeNull();
    expect((await resetSignin(a.identity.parentId, { reason: "Lost every way in; called back on the number we hold.", calledBack: true }, ADMIN)).ok).toBe(true);
    // The stamped row is gone with every device: the next device the portal meets is a new one, with no stamp.
    expect(await deviceRows(a.identity.parentId)).toEqual([]);
    expect(await db.select().from(parentDevice).where(eq(parentDevice.id, deviceId!))).toEqual([]);
    expect(await declinesOf(a.identity.parentId)).toBe(1);
  });
});
