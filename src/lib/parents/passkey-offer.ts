// The passkey offer on Home (the sign-in release, slice SI-8; section 6 of the app-owned families spec, "The passkey,
// offered", and open questions 28 and 31): right after a sign-in that proved the password and a second step, one
// prompt to add a passkey with one tap, through the add Sign-in settings already has (SI-7b: the library's ceremony and
// the portal's /portal-passkey/add, addMyPasskey(), passkey-settings.ts, which this module never calls). "Not now"
// keeps the offer away from that device for a month (`parent_device.passkey_offered_at`) and counts against the person
// (`parent.passkey_offer_declines`); after the third, on any device, only Sign-in settings offers the add. Both are kept
// on the server, never in a cookie or browser storage. The month holds for a device the portal still knows: under
// Strict, where a remembered device asks for the second step again and its row is renewed, at every sign-in there;
// under Standard a remembered device signs in by the password alone and is offered nothing, so the sessions offered
// there are made on a device just remembered, and a cleared browser, another browser on one phone or a private window
// is a new device, offered again at once. There the count of three is the limit (the lead's call, said in "The
// passkey offer" of docs/agents/sign-in.md). Everything is for the session's own person and device (`ctx.parentId`,
// `ctx.sessionId`): no id comes from the browser. The rule itself is pure (passkey-offer-rule.ts). Server only; parent
// code.
import "server-only";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent, parentAuthSession, parentAuthUser, parentDevice } from "@/lib/db/schema";
import { env } from "@/env";
import type { ParentCtx } from "@/lib/guards";
import { sessionStrongAt } from "./asking-again";
import { mayAddPasskey } from "./passkey-settings";
import { passkeyCount } from "./passkeys";
import { takeRateLimit } from "./rate-limit";
import { OFFER_AGAIN_AFTER_MS, MOST_DECLINES, declineCounts, offerDue, type OfferFacts } from "./passkey-offer-rule";
import { PASSKEY_OFFER_COPY as WORDS } from "./passkey-offer-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

type Me = Pick<ParentCtx, "parentId" | "sessionId">;
/** A query runner: the database, or the caller's transaction. */
type Reader = Pick<typeof db, "select">;

/**
 * What Home is given: whether to draw the box, and with it APP_URL's origin, where a passkey can be added. Never a
 * count, a time or an id.
 */
export type PasskeyOffer = { offered: false } | { offered: true; portalOrigin: string };

/**
 * The facts of the rule for this session of this person (OfferFacts), or null when there is no such session: when it
 * was made, its proof (sessionStrongAt(), which drops a proof older than the person's newest second factor), the device
 * it names while that is still a remembered device of this person's and unexpired, with its last "Not now", and the
 * person's count.
 */
async function offerFacts(q: Reader, s: Me, now: Date): Promise<OfferFacts | null> {
  const [session] = await q.select({ madeAt: parentAuthSession.createdAt, deviceId: parentAuthSession.deviceId }).from(parentAuthSession)
    .where(and(eq(parentAuthSession.id, s.sessionId),
      inArray(parentAuthSession.userId, q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, s.parentId)))));
  if (!session) return null;
  const [person] = await q.select({ declines: parent.passkeyOfferDeclines }).from(parent).where(eq(parent.id, s.parentId));
  if (!person) return null;
  const [device] = session.deviceId === null ? [] : await q.select({ offeredAt: parentDevice.passkeyOfferedAt }).from(parentDevice)
    .where(and(eq(parentDevice.id, session.deviceId), eq(parentDevice.parentId, s.parentId), gt(parentDevice.expiresAt, now)));
  return { sessionMadeAt: session.madeAt, strongAt: await sessionStrongAt(q, s), device: device ?? null, declines: person.declines };
}

/**
 * Whether Home offers this session a passkey now (decision 4 of SI-8; offerDue(), passkey-offer-rule.ts): the session
 * may add one with a single tap (mayAddPasskey(): sign-ins on, not blocked, a row that counts, a password chosen, a
 * proof within the window), it was made within the window and its sign-in itself proved the password and a second
 * step (a password on a remembered device stamps nothing and is offered nothing, nor after asking again on Sign-in
 * settings: provedAtSignin()), the person holds no passkey, the device it names is
 * theirs and has had no "Not now" in the last 30 days, and the person has pressed "Not now" fewer than three times.
 * Offered at both levels, an authenticator app's holder included. Drawing writes nothing.
 */
export async function passkeyOfferFor(ctx: Me, now = new Date()): Promise<PasskeyOffer> {
  const facts = await offerFacts(db, ctx, now);
  if (!facts) return { offered: false };
  const mayAdd = await mayAddPasskey(ctx, now);
  const passkeys = await passkeyCount(ctx.parentId);
  return offerDue({ ...facts, mayAdd, passkeys }, now) ? { offered: true, portalOrigin: new URL(env.APP_URL).origin } : { offered: false };
}

export type DeclineAnswer = { ok: true; message: string; last?: true } | { ok: false; errors: string[] };

/**
 * "Not now" on the offer (decision 7 of SI-8). It takes nothing from the browser: the device is the one the session
 * names, the person the session's. In order: a place under `signin_settings_parent` (the settings' presses' kind, 10 an
 * hour per person), then one transaction of its own: the person's row FOR UPDATE (taken alone: no other lock; the
 * comment above lockedPerson(), sessions.ts), the rule again under it (declineCounts(): the session's sign-in proved a
 * second step, the device due, fewer than three declines; not the session's age: a late answer is still the parent's
 * no), and then the device's `passkey_offered_at` set to now with the person in the update's own WHERE (and the stamp
 * still due), and only when that stamped a row, the person's count raised by one in the database
 * (`passkey_offer_declines + 1`), never a read then a write. A press whose offer is no longer due changes nothing and
 * answers the same thanks, so two taps, or two tabs, count once. Once the person's count stands at three, counted by
 * this press or before it (a second tab after the third), the answer says Home won't ask again (`last`). Unaudited
 * (NOT_AUDITED, tests/unit/audit-rows.test.ts): it grants and removes nothing, and a passkey added from the offer is
 * audited by the add (`parent.passkey.add`).
 */
export async function declinePasskeyOffer(ctx: Me, now = new Date()): Promise<DeclineAnswer> {
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) !== "taken") return { ok: false, errors: [COPY.tooManyPresses] };
  const declines = await db.transaction(async (tx: Tx) => {
    const [me] = await tx.select({ blocked: parent.blocked }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
    if (!me || me.blocked) return null;
    const facts = await offerFacts(tx, ctx, now);
    if (!facts) return null;
    // Not counted: the count as it stands, so a press after the third still says Home won't ask again.
    if (!declineCounts(facts, now)) return facts.declines;
    const deviceId = (await tx.select({ deviceId: parentAuthSession.deviceId }).from(parentAuthSession).where(eq(parentAuthSession.id, ctx.sessionId)))[0]?.deviceId;
    if (!deviceId) return facts.declines;
    const stamped = await tx.update(parentDevice).set({ passkeyOfferedAt: now })
      .where(and(eq(parentDevice.id, deviceId), eq(parentDevice.parentId, ctx.parentId), gt(parentDevice.expiresAt, now),
        or(isNull(parentDevice.passkeyOfferedAt), lte(parentDevice.passkeyOfferedAt, new Date(now.getTime() - OFFER_AGAIN_AFTER_MS)))))
      .returning({ id: parentDevice.id });
    if (stamped.length === 0) return facts.declines;
    const [counted] = await tx.update(parent).set({ passkeyOfferDeclines: sql`${parent.passkeyOfferDeclines} + 1` })
      .where(eq(parent.id, ctx.parentId)).returning({ declines: parent.passkeyOfferDeclines });
    return counted?.declines ?? null;
  });
  return declines !== null && declines >= MOST_DECLINES ? { ok: true, message: WORDS.declinedLast, last: true } : { ok: true, message: WORDS.declined };
}
