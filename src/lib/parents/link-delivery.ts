// The delivery of a held set-up or reset link (the sign-in release; slice SI-3a made it for the page "Set up or reset my
// password", and slice SI-4 shares it with the welcome): the link's mail goes, and only once it has been handed over
// is the link put in place, replacing the person's unused one; otherwise it is removed and the earlier one left
// working. Each outcome has its own audit row, written in the transaction that makes it true. Server only, and parent
// code: password-request.ts runs it on /sign-in/password, so it imports nothing staff-only.
import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent, parentAuthAccount, parentAuthUser, parentSigninToken } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { sendMail } from "@/lib/mail/send";
import type { MailMessage, MailPurpose } from "@/lib/mail/types";
import { env } from "@/env";
import { dropHeldLink, putHeldLinkInPlace, type LinkPurpose } from "./signin-links";

/** A link's life in words, for its mail: "1 hour", "7 days". */
export function lifeWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** The portal's own address, as APP_URL holds it, with no slash at its end. */
export const portalAddress = () => env.APP_URL.replace(/\/+$/, "");

/** The address a link opens: the portal's own address and the link's page, built as the email change builds its link. */
export const passwordLink = (purpose: LinkPurpose, token: string) =>
  `${portalAddress()}/sign-in/${purpose === "setup" ? "set-up" : "reset"}/${token}`;

/** A person as a link's sender reads them: their address, whether they are blocked, their sign-in account and whether they have a password. */
export type LinkPerson = { id: string; email: string; blocked: boolean; authUserId: string | null; hasPassword: boolean };

/** The person who holds the address, or has the id, with their sign-in account and whether they have a password; in `tx` when given. */
export async function personBy(where: { email: string } | { id: string }, tx?: Tx): Promise<LinkPerson | null> {
  const [row] = await (tx ?? db).select({
    id: parent.id, email: parent.email, blocked: parent.blocked, authUserId: parentAuthUser.id,
    hasPassword: sql<boolean>`exists (select 1 from ${parentAuthAccount} where ${parentAuthAccount.userId} = ${parentAuthUser.id} and ${parentAuthAccount.providerId} = 'credential')`,
  }).from(parent).leftJoin(parentAuthUser, eq(parentAuthUser.parentId, parent.id))
    .where("email" in where ? eq(parent.email, where.email) : eq(parent.id, where.id));
  return row ? { ...row, hasPassword: row.hasPassword === true } : null;
}

/** A held link on its way (holdSigninLink(), signin-links.ts): its token, which only its mail carries, the address it goes to, and whose it is. */
export type HeldLink = { linkId: string; purpose: LinkPurpose; token: string; to: string; who: { id: string; email: string } };

/**
 * The check made again under the person's lock before a link whose mail was handed over is put in place: given the
 * transaction and the person read again in it (null when they are gone), the reason the link may no longer be put in
 * place, for its `parent.password.link_not_sent` row, or null when it may.
 */
export type DeliveryCheck = (tx: Tx, live: LinkPerson | null) => Promise<string | null>;

/**
 * What became of a delivery: the mail was not handed over (the held link is removed, the earlier one still works); or it
 * was, and the link is in place (the person's one live link of its purpose), or it was not put in place, with the reason
 * of its `link_not_sent` row (a reason of the check, `superseded`, `changed_while_mailing`, `not_put_in_place`).
 */
export type Delivered = { handedOver: false; error: string } | { handedOver: true; inPlace: true } | { handedOver: true; inPlace: false; reason: string };

/** Why a mail wasn't handed over when the message itself couldn't be written (the club's name not read, say): a fixed sentence, as a send failure's is. */
const NOT_WRITTEN = "The email couldn't be written.";

type Options = { message: () => Promise<MailMessage>; purpose: MailPurpose; actor: Actor; permission?: string; ip: string | null; check: DeliveryCheck };

/** Postgres ended the transaction to break a deadlock (40P01), or for a serialization failure (40001): worth one more try. */
function worthAnotherTry(e: unknown): boolean {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  const c = code(e) ?? code((e as { cause?: unknown } | null)?.cause);
  return c === "40P01" || c === "40001";
}

/** One `parent.password.link_not_sent` row, in the transaction that makes it true. (Put in place, its row is `link_made`, putHeldLinkInPlace().) */
async function notSent(l: HeldLink, o: Options, reason: string, tx: Tx) {
  await writeAudit({ actor: o.actor, action: "parent.password.link_not_sent", permission: o.permission, targetType: "parent", targetId: l.who.id,
    after: { purpose: l.purpose, reason }, ip: o.ip }, tx);
}

/**
 * Delivers a held link: its mail (written by `message`, which may throw: then it was never handed over) goes to the
 * address read under the lock when it was held, and no other. The person's earlier link keeps working until the new one
 * is put in place, and that happens only once its mail has been handed over: a send that fails, or a putting in place
 * that fails (tried once more after a deadlock or a serialization failure), removes the held link instead, each with its
 * own reason. It never throws: every outcome is audited (mail.failed, and the rows below), and one whose own row could
 * not be written is answered as what was known when it failed. The token is in the mail's body alone.
 */
export async function deliverHeldLink(l: HeldLink, o: Options): Promise<Delivered> {
  const sent = await (async () => sendMail(await o.message(), { purpose: o.purpose, actor: o.actor, ip: o.ip }))()
    .catch(() => ({ ok: false as const, error: NOT_WRITTEN }));
  if (!sent.ok) {
    await forgetUnsentLink(l, o, "mail_failed").catch(() => undefined);
    return { handedOver: false, error: sent.error };
  }
  try {
    return await putLinkInPlace(l, o).catch((e: unknown) => { if (worthAnotherTry(e)) return putLinkInPlace(l, o); throw e; });
  } catch {
    const liveAfterAll = await forgetUnsentLink(l, o, "not_put_in_place").catch(() => false);
    return liveAfterAll ? { handedOver: true, inPlace: true } : { handedOver: true, inPlace: false, reason: "not_put_in_place" };
  }
}

/**
 * A link whose mail was handed over, put in place (putHeldLinkInPlace()) once the person is checked again under their
 * lock (`check`). An end of the person's sign-in meanwhile (blocking, a last membership closed, a change of address,
 * sign-ins switched off) deleted the held link with the unused ones (unspentLink, ./link-state.ts), so it stays gone
 * even when the person is let in again before the mail is handed over; a newer link made meanwhile (mintSigninLink())
 * deleted it too, and wins. Put in place, its row is `parent.password.link_made`. When the check says no, the held link
 * is removed and one `parent.password.link_not_sent` row gives the reason; when the link is no longer held, nothing is
 * removed and the row says `superseded` (a newer link mintSigninLink() made replaced it) or `changed_while_mailing` (an
 * end of the person's sign-in, or a password reset). Throws when the transaction fails.
 */
async function putLinkInPlace(l: HeldLink, o: Options): Promise<Delivered> {
  return db.transaction(async (tx): Promise<Delivered> => {
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, l.who.id)).for("update");
    const live = await personBy({ id: l.who.id }, tx);
    const reason = await o.check(tx, live);
    if (reason === null && live) {
      const put = await putHeldLinkInPlace(tx, { linkId: l.linkId, parentId: live.id, purpose: l.purpose, actor: o.actor, ip: o.ip });
      if (put === "put") return { handedOver: true, inPlace: true };
      const why = put === "superseded" ? "superseded" : "changed_while_mailing";
      await notSent(l, o, why, tx);
      return { handedOver: true, inPlace: false, reason: why };
    }
    await dropHeldLink(tx, l.linkId);
    await notSent(l, o, reason ?? "changed_while_mailing", tx);
    return { handedOver: true, inPlace: false, reason: reason ?? "changed_while_mailing" };
  });
}

/**
 * A link whose mail was not handed over (`mail_failed`), or was and whose putting in place then failed
 * (`not_put_in_place`): nobody may use it. Under the person's row, in the order above lockedPerson(), it looks first:
 * a link that is live after all (the putting in place committed and only its answer was lost) is left as it is, with no
 * row, and the answer is true. Otherwise the held link is removed with one `parent.password.link_not_sent` row giving
 * the reason. The person's earlier link, if any, was never touched and still works.
 */
async function forgetUnsentLink(l: HeldLink, o: Options, reason: "mail_failed" | "not_put_in_place"): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, l.who.id)).for("update");
    const [live] = await tx.select({ id: parentSigninToken.id }).from(parentSigninToken)
      .where(and(eq(parentSigninToken.id, l.linkId), isNull(parentSigninToken.usedAt)));
    if (live) return true;
    await dropHeldLink(tx, l.linkId);
    await notSent(l, o, reason, tx);
    return false;
  });
}
