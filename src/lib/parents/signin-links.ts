// A person's one-time set-up and reset links (the sign-in release, slice SI-2; section 6 of the app-owned families spec,
// "Signing in"; open questions 23 and 34). A link carries a random token in its address; the portal keeps only a keyed
// hash of it, in `parent_signin_token`. Server only. The token itself is returned once, to the caller that makes the
// link and mails it, and is never stored, logged or audited.
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { auditLog, parent, parentAuthAccount, parentAuthUser, parentSigninToken } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
import { heldLink, unspentLink } from "./link-state";
import { enterableGuardianRows } from "./sessions";
import { getParentSettings, parentDoorClosed } from "./settings";

export const LINK_PURPOSES = ["setup", "reset"] as const;
/** `setup` chooses a first password; `reset` chooses a new one in place of the one the person has. */
export type LinkPurpose = (typeof LINK_PURPOSES)[number];
export const isLinkPurpose = (v: unknown): v is LinkPurpose => v === "setup" || v === "reset";

const HOUR_MS = 60 * 60 * 1000;
/**
 * How long a link works. A set-up link goes in the welcome and may wait in a mailbox for days (open question 34: 7
 * days); a reset link is asked for at the moment it is needed, so it lives an hour (the lead's choice 5).
 */
export const LINK_LIFE_MS: Record<LinkPurpose, number> = { setup: 7 * 24 * HOUR_MS, reset: HOUR_MS };

/** 32 random bytes, written base64url: 43 characters, each safe in a path segment. */
export const LINK_TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** Whether a value from the browser has a token's shape. Anything else is no link, answered without a query. */
export const isLinkToken = (v: unknown): v is string => typeof v === "string" && TOKEN_SHAPE.test(v);

/**
 * What is stored for a token: an HMAC-SHA256 keyed with the server secret, as a sign-in code's is (signin-codes.ts), so a
 * copy of the database alone can't be searched. The purpose is part of what is hashed, so a set-up token is never found
 * as a reset token, nor the other way round. Also the key a token's rate limit counts under, so the token is never kept.
 */
export const hashLinkToken = (purpose: LinkPurpose, token: string): string =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`signin-link:${purpose}:${token}`).digest("hex");

/**
 * Makes a person's link of one purpose and returns its token. In the caller's transaction, which takes the person's row
 * first, in the order above lockedPerson() (./sessions.ts): this takes it FOR UPDATE again (a lock the transaction holds
 * already is not waited for), so it holds even for a caller that took nothing yet. Before anything else of the person is
 * touched later in the same transaction, then, the links: the person's unspent links of this purpose are deleted
 * (unspentLink, ./link-state.ts): the unused one, expired or not (an unused one past its expiry still holds the place
 * `parent_signin_token_one_live_uq` keeps until the daily clean-up), and a held one whose mail is on its way, so the
 * newer link always wins (putHeldLinkInPlace() then finds its held link gone and puts nothing in place); and the new one
 * is stored with its life from `now`. Audited `parent.password.link_made` in the same
 * transaction, with the purpose, its expiry and how many it replaced (a held one counted), never the token or its hash; the caller's own row
 * says why the link was made. For a caller whose mail goes out in the same work as the link (the staff reset, SI-9,
 * will call it). The page that asks for a link and, since SI-4, the welcome mail after their transaction, and so hold
 * their link until the mail is handed over instead (holdSigninLink(), below). Throws for a person who doesn't exist.
 */
export async function mintSigninLink(tx: Tx, o: { parentId: string; purpose: LinkPurpose; actor: Actor; ip: string | null; now?: Date }): Promise<string> {
  const now = o.now ?? new Date();
  const [person] = await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, o.parentId)).for("update");
  if (!person) throw new Error("mintSigninLink: no such person");
  const replaced = await tx.delete(parentSigninToken)
    .where(and(eq(parentSigninToken.parentId, person.id), eq(parentSigninToken.purpose, o.purpose), unspentLink))
    .returning({ id: parentSigninToken.id, held: sql<boolean>`${heldLink}` });
  const token = randomBytes(LINK_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_LIFE_MS[o.purpose]);
  await tx.insert(parentSigninToken).values({ purpose: o.purpose, parentId: person.id, tokenHash: hashLinkToken(o.purpose, token), createdAt: now, expiresAt });
  // The held links it replaced are named by id (never a token or a hash), so the delivery of one tells "a newer link
  // replaced it" (`superseded`) from "an end of sign-in or a reset removed it" by this row alone: supersededBy(), below.
  await writeAudit({ actor: o.actor, action: "parent.password.link_made", targetType: "parent", targetId: person.id,
    after: { purpose: o.purpose, expiresAt: expiresAt.toISOString(), replaced: replaced.length, heldReplaced: replaced.filter((r) => r.held).map((r) => r.id) }, ip: o.ip }, tx);
  return token;
}

/**
 * A held link (heldLink, ./link-state.ts): stored with `used_at` set to its own `created_at`, so it works for nobody yet
 * (linkVerdict() reads it as used) and holds no place under `parent_signin_token_one_live_uq`, so the person's earlier
 * unused link of that purpose stays as it is and keeps working. Everything that deletes a person's unused links deletes
 * a held one too (unspentLink), so putHeldLinkInPlace() then finds nothing to put in place.
 */
const isHeld = heldLink;

/**
 * Makes a held link (isHeld, above) for a link whose mail goes out after this transaction: the request page's
 * (askForPasswordLink(), password-request.ts) and, since SI-4, the welcome's (sendOwedWelcomes() and resendWelcome(),
 * welcome.ts), each delivered by deliverHeldLink() (link-delivery.ts). In the caller's transaction, under the person's lock the caller took.
 * The request page's own row in that transaction says the link is on its way (`parent.password.reset_asked`, `link:
 * "on_its_way"`); the welcome writes no row there: its claim (`welcome_tried_at`) and the delivery's `link_made` or
 * `link_not_sent` row are its trace. Once the mail has been handed over, putHeldLinkInPlace() makes it
 * the person's one live link of its purpose; if it never is, dropHeldLink() removes it. One the portal never comes back
 * to (the process stopped mid-send) is a spent link to the daily clean-up, gone after a code's life.
 */
export async function holdSigninLink(tx: Tx, o: { parentId: string; purpose: LinkPurpose; now: Date }): Promise<{ linkId: string; token: string }> {
  const token = randomBytes(LINK_TOKEN_BYTES).toString("base64url");
  const [row] = await tx.insert(parentSigninToken).values({ purpose: o.purpose, parentId: o.parentId, tokenHash: hashLinkToken(o.purpose, token),
    createdAt: o.now, expiresAt: new Date(o.now.getTime() + LINK_LIFE_MS[o.purpose]), usedAt: o.now }).returning({ id: parentSigninToken.id });
  return { linkId: row!.id, token };
}

/**
 * A held link whose mail has been handed over, put in place: the person's unused link of its purpose is deleted (the
 * mail just sent replaces it, as mintSigninLink() replaces one) and the held one made unused, so it works (`put`).
 * When it is no longer held, nothing is put in place or deleted: `superseded` when mintSigninLink() deleted it (its
 * `link_made` row names it among `heldReplaced`: the newer link wins), else `gone` (an end of the person's sign-in, or a
 * password reset, deleted it; a later ask's link, held or put in place since, never makes it `superseded`). In the caller's transaction, under the person's lock the caller took (the
 * caller checks the person again under it first). Audited `parent.password.link_made` as mintSigninLink() audits a link,
 * with its purpose, expiry and how many it replaced, when it is put in place.
 */
export async function putHeldLinkInPlace(tx: Tx, o: { linkId: string; parentId: string; purpose: LinkPurpose; actor: Actor; ip: string | null }):
  Promise<"put" | "superseded" | "gone"> {
  const [held] = await tx.select({ id: parentSigninToken.id, expiresAt: parentSigninToken.expiresAt }).from(parentSigninToken)
    .where(and(eq(parentSigninToken.id, o.linkId), eq(parentSigninToken.parentId, o.parentId), eq(parentSigninToken.purpose, o.purpose), isHeld)).for("update");
  if (!held) return (await supersededBy(tx, o.parentId, o.linkId)) ? "superseded" : "gone";
  const replaced = await tx.delete(parentSigninToken)
    .where(and(eq(parentSigninToken.parentId, o.parentId), eq(parentSigninToken.purpose, o.purpose), isNull(parentSigninToken.usedAt)))
    .returning({ id: parentSigninToken.id });
  await tx.update(parentSigninToken).set({ usedAt: null }).where(eq(parentSigninToken.id, held.id));
  await writeAudit({ actor: o.actor, action: "parent.password.link_made", targetType: "parent", targetId: o.parentId,
    after: { purpose: o.purpose, expiresAt: held.expiresAt.toISOString(), replaced: replaced.length }, ip: o.ip }, tx);
  return "put";
}

/**
 * Whether mintSigninLink() deleted this held link: its `link_made` row for the person names the link among the held
 * links it replaced (`heldReplaced`). Only a mint deletes a held link for a newer one; whatever else removed it (an end
 * of the person's sign-in, a reset) wrote no such row, whatever links the person was asked for or given since.
 */
async function supersededBy(tx: Tx, parentId: string, linkId: string): Promise<boolean> {
  const [row] = await tx.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.targetType, "parent"), eq(auditLog.targetId, parentId),
    eq(auditLog.action, "parent.password.link_made"), sql`${auditLog.after}->'heldReplaced' @> ${JSON.stringify([linkId])}::jsonb`)).limit(1);
  return row !== undefined;
}

/** Removes a held link whose mail never went (or whose person changed while it went), while it is still held. */
export async function dropHeldLink(tx: Tx, linkId: string): Promise<void> {
  await tx.delete(parentSigninToken).where(and(eq(parentSigninToken.id, linkId), isHeld));
}

/**
 * Whether the person was sent a link of this purpose less than `withinMs` ago that may still be in their mailbox
 * unused: a live one made since then (unused, not expired), or a held one on its way. The request page mails nothing
 * while one is (askForPasswordLink()'s resend wait), so a second ask doesn't replace the link the first one sent.
 */
export async function linkSentWithin(tx: Tx, o: { parentId: string; purpose: LinkPurpose; now: Date; withinMs: number }): Promise<boolean> {
  const [row] = await tx.select({ id: parentSigninToken.id }).from(parentSigninToken).where(and(
    eq(parentSigninToken.parentId, o.parentId), eq(parentSigninToken.purpose, o.purpose),
    gt(parentSigninToken.createdAt, new Date(o.now.getTime() - o.withinMs)),
    or(and(isNull(parentSigninToken.usedAt), gt(parentSigninToken.expiresAt, o.now)), isHeld))).limit(1);
  return row !== undefined;
}

/**
 * Why a link can't be used. About the link: it names nothing (unknown), was spent (used), ran out (expired), or is a
 * set-up link for someone with a password (has_password). About its person and the door: they have no sign-in account
 * (no_sign_in_account), are blocked (blocked), have no guardian row that counts (no_enabled_guardian), or parent
 * sign-ins are switched off (signins_off). Every one can be the reason of a `parent.password.refused` row.
 */
export type LinkRefusal = "unknown" | "used" | "expired" | "has_password" | "no_sign_in_account" | "blocked" | "no_enabled_guardian" | "signins_off";
export type UsableLink = { tokenId: string; parentId: string; email: string; authUserId: string; hasPassword: boolean };
/**
 * Whether a link may be used. A refusal carries its reason and the person it named, for the audit row only: whoever
 * shows the answer shows one thing for every reason, and never who it was.
 */
export type LinkVerdict = { ok: true; link: UsableLink } | { ok: false; reason: LinkRefusal; who: { id: string; email: string } | null };

/** No person has this id: the guardian rows of an unknown link are read for it, so every refusal makes the same reads. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * The one decision whether a link may be used, which the page a link opens and the form's action both go through:
 * the token names a link of this purpose that is unused and not past its expiry (a set-up link only while its person
 * has no password: no `credential` row in `parent_auth_account`); its person has a sign-in account (`parent_auth_user`:
 * nothing signs in without one), is not blocked, and has a guardian row that counts (enterableGuardianRows(), the
 * gate's rule); and the parent door is open. It writes nothing. A token of the wrong shape is no link, answered without
 * a query; any other makes the same reads whatever the answer (the settings, the link with its person, their rows).
 *
 * With `tx` and `lock`, inside the transaction that sets the password: the link's row is read FOR UPDATE, after the
 * caller took the person's row (the order above lockedPerson(), ./sessions.ts), so a second use waits and then finds it
 * spent.
 */
export async function linkVerdict(purpose: LinkPurpose, token: unknown, o: { now?: Date; tx?: Tx; lock?: boolean } = {}): Promise<LinkVerdict> {
  if (!isLinkToken(token)) return { ok: false, reason: "unknown", who: null };
  const now = o.now ?? new Date();
  const q = o.tx ?? db;
  const settings = await getParentSettings(o.tx);
  const read = () => q.select({
    tokenId: parentSigninToken.id, parentId: parentSigninToken.parentId, expiresAt: parentSigninToken.expiresAt, usedAt: parentSigninToken.usedAt,
    email: parent.email, blocked: parent.blocked, authUserId: parentAuthUser.id,
    hasPassword: sql<boolean>`exists (select 1 from ${parentAuthAccount} where ${parentAuthAccount.userId} = ${parentAuthUser.id} and ${parentAuthAccount.providerId} = 'credential')`,
  }).from(parentSigninToken).innerJoin(parent, eq(parent.id, parentSigninToken.parentId)).leftJoin(parentAuthUser, eq(parentAuthUser.parentId, parent.id))
    .where(and(eq(parentSigninToken.tokenHash, hashLinkToken(purpose, token)), eq(parentSigninToken.purpose, purpose)));
  const [row] = o.lock ? await read().for("update", { of: parentSigninToken }) : await read();
  const rows = await enterableGuardianRows(row?.parentId ?? NOBODY, o.tx);
  if (!row) return { ok: false, reason: "unknown", who: null };
  const who = { id: row.parentId, email: row.email };
  const hasPassword = row.hasPassword === true;
  const reason: LinkRefusal | null = row.usedAt !== null ? "used"
    : row.expiresAt.getTime() <= now.getTime() ? "expired"
      : purpose === "setup" && hasPassword ? "has_password"
        : row.authUserId === null ? "no_sign_in_account"
          : row.blocked ? "blocked"
            : rows.length === 0 ? "no_enabled_guardian"
              : parentDoorClosed(settings) ? "signins_off" : null;
  if (reason !== null || row.authUserId === null) return { ok: false, reason: reason ?? "no_sign_in_account", who };
  return { ok: true, link: { tokenId: row.tokenId, parentId: row.parentId, email: row.email, authUserId: row.authUserId, hasPassword } };
}
