// A person's one-time set-up and reset links (the sign-in release, slice SI-2; section 6 of the app-owned families spec,
// "Signing in"; open questions 23 and 34). A link carries a random token in its address; the portal keeps only a keyed
// hash of it, in `parent_signin_token`. Server only. The token itself is returned once, to the caller that makes the
// link and mails it, and is never stored, logged or audited.
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent, parentAuthAccount, parentAuthUser, parentSigninToken } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
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
 * touched later in the same transaction, then, the links: the person's unused link of this purpose is deleted, expired
 * or not (an unused one past its expiry still holds the place `parent_signin_token_one_live_uq` keeps until the daily
 * clean-up), and the new one is stored with its life from `now`. Audited `parent.password.link_made` in the same
 * transaction, with the purpose, its expiry and how many it replaced, never the token or its hash; the caller's own row
 * says why the link was made. Nothing in the portal calls this yet (slice SI-2): the welcome (SI-4), the page that asks
 * for a link (SI-3a) and the staff reset (SI-9) will. Throws for a person who doesn't exist.
 */
export async function mintSigninLink(tx: Tx, o: { parentId: string; purpose: LinkPurpose; actor: Actor; ip: string | null; now?: Date }): Promise<string> {
  const now = o.now ?? new Date();
  const [person] = await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, o.parentId)).for("update");
  if (!person) throw new Error("mintSigninLink: no such person");
  const replaced = await tx.delete(parentSigninToken)
    .where(and(eq(parentSigninToken.parentId, person.id), eq(parentSigninToken.purpose, o.purpose), isNull(parentSigninToken.usedAt)))
    .returning({ id: parentSigninToken.id });
  const token = randomBytes(LINK_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_LIFE_MS[o.purpose]);
  await tx.insert(parentSigninToken).values({ purpose: o.purpose, parentId: person.id, tokenHash: hashLinkToken(o.purpose, token), createdAt: now, expiresAt });
  await writeAudit({ actor: o.actor, action: "parent.password.link_made", targetType: "parent", targetId: person.id,
    after: { purpose: o.purpose, expiresAt: expiresAt.toISOString(), replaced: replaced.length }, ip: o.ip }, tx);
  return token;
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
