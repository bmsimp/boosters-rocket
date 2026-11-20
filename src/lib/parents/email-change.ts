// Parent-facing: a parent changes the address they sign in with (v1 spec §6.2, parents spec §2 Email changes;
// app-owned families spec section 6: a guardian's sign-in email is the app's record). Since stage 3's slice 11d the
// confirmed change is the portal's alone: the person's own sign-in address changes in one transaction, and nothing of
// QuickBooks or the roster cache is read or written. Slice S11e sends it on to the person's records in QuickBooks, by
// the changes saved first; the two are released together.
// Privacy: whose address changes is decided from the session's ParentCtx and nothing else. The token a link carries is
// untrusted: it is found by its hash, and only among the requests of the session's own person, link and family. This
// module is in the staff-only import scan (tests/integration/page-guards.test.ts), and it imports nothing from the
// QuickBooks client (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, parent, parentAuthSession, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { env } from "@/env";
import { normalizeEmail } from "@/lib/email";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { emailChangeConfirmMessage, emailChangeNoticeMessage } from "@/lib/mail/messages";
import { takeRateLimit } from "./rate-limit";
import { deleteUnusedSigninCodes, deleteUnusedSigninLinks, endParentSessions, enterableGuardianRows, forgetDevices, lockEmail, parentActor } from "./sessions";
import { getParentSettings } from "./settings";

/** How long the link mailed to the new address works. */
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

export const EMAIL_COPY = {
  askTheClub: "Your sign-in email can't be changed here. Please ask the club and they'll change it for you.",
  invalid: "Please enter a whole email address, like name@example.com.",
  same: "That's the address you sign in with now.",
  sent: (email: string) => `We've sent a link to ${email}. Open it within 24 hours to finish the change. Until then, keep signing in with the address you use now.`,
  notSent: "We couldn't send the email just now, so nothing has changed. Please try again in a little while.",
  tooManyAsks: "You've asked to change your sign-in email a few times in the last hour. Please wait a little while before trying again.",
  tooManyTries: "You've tried this link a few times in the last hour. Please wait a little while before trying again.",
  /** Every link that can't be used gets these words, whatever the reason: expired, used, someone else's, not a link at all. */
  linkNoGood: "This link has expired or has already been used. If you still want to change your sign-in email, you can ask for a new link on the Family page.",
  /** The change couldn't be made just now, whatever the reason: nothing went through, and the link works again. */
  tryLater: "We couldn't make the change just now, so nothing was changed. Please open the link again in a little while.",
  /** The session that confirmed was signed out, or the person blocked, while the change was being made. */
  notMade: "Your sign-in email wasn't changed, because you were signed out while it was being made. If you still want to change it, please sign in again and ask once more.",
  cantHere: "That change can't be made here, so nothing was changed. Please ask the club to change your sign-in email.",
  done: (email: string) => `Done. From now on, sign in with ${email}.`,
  /** When the change is made and the new address can't sign in to this family yet, whatever the reason. */
  finishing: "Your sign-in email is changed. Your new address will work for signing in once the club lets you sign in to the portal again.",
} as const;

export type EmailResult = { ok: true; message: string } | { ok: false; errors: string[] };
/** After a confirmation that was made, the person's sessions have ended: `signedOut` says so, so the page offers the sign-in page. */
export type ConfirmResult = { ok: true; message: string; signedOut: true } | { ok: false; errors: string[] };

const actorOf = (ctx: ParentCtx) => parentActor({ id: ctx.parentId, email: ctx.email });
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** A token as this module makes them: 32 random bytes, URL-safe base64. Anything else is never looked up. */
const isToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);

/** The address of the link mailed to the new address: the portal's own address, then the token. */
export const emailChangeLink = (token: string) => `${env.APP_URL.replace(/\/+$/, "")}/family/email/${token}`;

/**
 * Whether the signed-in parent may change their sign-in address from the portal: parent sign-ins are on, and the
 * session's own guardian row is among the person's open rows. Nothing of QuickBooks is read, and the person may be a
 * guardian of any number of families: the address is the person's, one per person, and stage 3's slice S11e sends it
 * on to each record of theirs (app-owned families spec, Appendix B). Otherwise the pages offer nothing, and the email
 * page tells them to ask the club.
 */
export async function canChangeMyEmail(ctx: ParentCtx): Promise<boolean> {
  const [settings, [row]] = await Promise.all([
    getParentSettings(),
    db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.id, ctx.guardianId), eq(guardian.parentId, ctx.parentId), ne(guardian.status, "disabled"))),
  ]);
  return settings.signin && row !== undefined;
}

/**
 * Asks for the change: stores it, and mails a link to the new address and a notice to the old one. Nothing else
 * changes. `input` is what the browser sent, untrusted. The answer is the same whatever the new address is: whether
 * anyone in the portal or in QuickBooks has it is never said. An earlier request of the person that wasn't used is
 * replaced, so only the newest link works.
 */
export async function requestMyEmailChange(ctx: ParentCtx, input: unknown): Promise<EmailResult> {
  const refused = async (code: string, errors: string[]): Promise<EmailResult> => {
    await writeAudit({ actor: actorOf(ctx), action: "parent.email.request.failed", targetType: "parent", targetId: ctx.parentId, after: { code }, ip: ctx.ip });
    return { ok: false, errors };
  };
  const take = await takeRateLimit("email_request_parent", ctx.parentId);
  if (take === "refused") return { ok: false, errors: [EMAIL_COPY.tooManyAsks] };
  if (take === "first_refusal") return refused("rate_limited", [EMAIL_COPY.tooManyAsks]);

  const email = typeof input === "string" && input.length <= 320 ? normalizeEmail(input) : null;
  if (!email) return { ok: false, errors: [EMAIL_COPY.invalid] };
  if (email === ctx.email.trim().toLowerCase()) return { ok: false, errors: [EMAIL_COPY.same] };
  if (!(await canChangeMyEmail(ctx))) return refused("not_offered", [EMAIL_COPY.askTheClub]);

  const token = randomBytes(32).toString("base64url");
  const actor = actorOf(ctx);
  await db.transaction(async (tx) => {
    // The person's row first, as every change of a person's sign-in does: two asks at once end with one live request.
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, ctx.parentId), isNull(parentEmailChange.usedAt)));
    // The request is asked in the session's own family (the app's family record the gate gave it). It names no
    // QuickBooks record (`record_qbo_id` stays null, read by nothing): the address is the person's.
    await tx.insert(parentEmailChange).values({ parentId: ctx.parentId, guardianId: ctx.guardianId, familyId: ctx.familyId, recordQboId: null,
      newEmail: email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) });
    await writeAudit({ actor, action: "parent.email.request", targetType: "parent", targetId: ctx.parentId, before: { email: ctx.email },
      after: { email, familyId: String(ctx.familyId) }, ip: ctx.ip }, tx);
  });
  const brand = await currentBrand();
  const sent = await sendMail(emailChangeConfirmMessage(brand, email, { link: emailChangeLink(token) }), { purpose: "email_change_confirm", actor, ip: ctx.ip });
  if (!sent.ok) return { ok: false, errors: [EMAIL_COPY.notSent] };
  await sendMail(emailChangeNoticeMessage(brand, ctx.email), { purpose: "email_change_notice", actor, ip: ctx.ip });
  return { ok: true, message: EMAIL_COPY.sent(email) };
}

type Request = typeof parentEmailChange.$inferSelect;

/**
 * The live request this token is for, made by the session's own person under the session's own link, in the session's
 * own family: a request asked in another family (`parent_email_change.family_id`, the app's family it was asked in),
 * or in none, is never live here.
 */
async function liveRequest(ctx: ParentCtx, token: unknown): Promise<Request | null> {
  if (!isToken(token)) return null;
  const [row] = await db.select().from(parentEmailChange).where(and(
    eq(parentEmailChange.tokenHash, hashToken(token)), isNull(parentEmailChange.usedAt), gt(parentEmailChange.expiresAt, new Date()),
    eq(parentEmailChange.parentId, ctx.parentId), eq(parentEmailChange.guardianId, ctx.guardianId), eq(parentEmailChange.familyId, ctx.familyId)));
  return row ?? null;
}

export type EmailLinkView =
  /** Any link that can't be used, whatever the reason: expired, used, another person's, not a link at all. */
  | { state: "gone" }
  /** The person's own link, and they may no longer make the change here. */
  | { state: "ask_club" }
  /** The question to put: "Use <newEmail> to sign in from now on?" */
  | { state: "ask"; newEmail: string };

/**
 * What the page a link opens shows. It changes nothing: mail scanners open links. The token is looked up only among
 * the session's own requests (liveRequest()), and the person must still be one who may change their address here.
 */
export async function findMyEmailChange(ctx: ParentCtx, token: unknown): Promise<EmailLinkView> {
  const row = await liveRequest(ctx, token);
  if (!row) return { state: "gone" };
  if (!(await canChangeMyEmail(ctx))) return { state: "ask_club" };
  return { state: "ask", newEmail: row.newEmail };
}

/** The Postgres error code of a failure, if it has one. Drizzle wraps the driver's error, so its cause is read too. */
const pgCode = (e: unknown): unknown => {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  return code(e) ?? code((e as { cause?: unknown } | null)?.cause);
};
/** Postgres ended the transaction to break a deadlock (40P01), or for a serialization failure (40001): worth one more try. */
const worthAnotherTry = (e: unknown): boolean => pgCode(e) === "40P01" || pgCode(e) === "40001";
/** The confirm's finish found, under the person's row, that it may not change the address: why, for the audit row. */
class NotFinished extends Error { constructor(readonly why: "session_ended" | "blocked" | "person_gone") { super(why); } }

/**
 * Confirms the change the link was mailed for. `token` comes from the browser, untrusted: it must be a live request of
 * the session's own person, link and family (liveRequest()), or the answer is the same as for a link that has expired.
 * The address changed is the session's own person's, never one named by the browser, and the person must still be one
 * who may change it here (canChangeMyEmail()). One address is one person: an address another person signs in with is
 * refused before anything changes, and the link is spent, since it can never work.
 *
 * Then the portal, in one transaction, in the order ./sessions.ts gives (lockedPerson()): both address locks, then the
 * person's row, then the request is spent (one already spent, by another press of the same link, ends it there: nothing
 * more is done or audited, and this press is told as that one was; one deleted since it was read, by a block, a
 * removal, a new ask or the change-of-company clear, is told as signed out when the person was blocked or the session
 * ended, and otherwise as a link that no longer works, `bad_link`); then, read again under that row, the person still
 * there and not blocked and the session that confirms still existing (ended meanwhile by any end of it, the change
 * stops: thrown, so the spend goes back with the rest, recorded with its own code, `session_ended`, `blocked` or
 * `person_gone`, and the one who pressed is told the change wasn't made); then the new address checked again (should
 * another person have come to hold it since, two links to one address confirmed at once, the person keeps theirs,
 * nobody is signed out, the request stays spent and the parent is told to ask the club); then their own address
 * changes (`parent.email` and their sign-in account's), their other requests go, then their unused sign-in codes,
 * their unused set-up and reset links and their remembered devices, then their sessions end, so the old address signs
 * in nowhere from that moment, and `parent.email.save` is written in that transaction. The password stays. Nothing here
 * opens, moves or closes a guardian row: the person keeps the families they had. Nothing of QuickBooks or the roster
 * cache is read or written, and no roster lock is taken: slice S11e sends the new address on.
 *
 * Postgres ending the transaction for a deadlock or a serialization failure is tried once more. Any other failure
 * changes nothing and leaves the request live, so the link works again until it expires: it is recorded in a
 * transaction of its own with its short code, and the parent is told to try again in a little while.
 */
export async function confirmMyEmailChange(ctx: ParentCtx, token: unknown): Promise<ConfirmResult> {
  const actor = actorOf(ctx);
  const failed = (code: string, tx?: Tx) => writeAudit({ actor, action: "parent.email.save.failed", targetType: "parent", targetId: ctx.parentId,
    after: { code: code.slice(0, 40) }, ip: ctx.ip }, tx);
  const refuse = async (code: string, errors: string[]): Promise<ConfirmResult> => {
    await failed(code);
    return { ok: false, errors };
  };
  /** Marks the request used; false when it was no longer there to spend (another confirmation of the same link got to it first). */
  const spend = async (id: string, tx?: Tx): Promise<boolean> => (await (tx ?? db).update(parentEmailChange).set({ usedAt: new Date() })
    .where(and(eq(parentEmailChange.id, id), isNull(parentEmailChange.usedAt))).returning({ id: parentEmailChange.id })).length > 0;

  // Counted first, so that whatever follows (an audit row for each refusal among it) is bounded per person.
  const take = await takeRateLimit("email_confirm_parent", ctx.parentId);
  if (take === "refused") return { ok: false, errors: [EMAIL_COPY.tooManyTries] };
  if (take === "first_refusal") return refuse("rate_limited", [EMAIL_COPY.tooManyTries]);

  const row = await liveRequest(ctx, token);
  if (!row) return refuse("bad_link", [EMAIL_COPY.linkNoGood]);
  if (!(await canChangeMyEmail(ctx))) return refuse("not_offered", [EMAIL_COPY.askTheClub]);
  // One address is one person: one another person signs in with is never taken, and the words never say why.
  if (await heldByAnother(db, row.newEmail, ctx.parentId)) {
    await spend(row.id);
    return refuse("address_taken", [EMAIL_COPY.cantHere]);
  }

  const oldEmail = ctx.email.trim().toLowerCase(), newEmail = row.newEmail;
  const finish = () => db.transaction(async (tx): Promise<"changed" | "taken" | "gone" | null> => {
    // The person first, in the order ./sessions.ts gives (lockedPerson()): both addresses, then the person's row, then
    // what hangs on the person, their email change requests, sign-in codes, set-up and reset links, remembered devices
    // and sessions, in that order. An ask, a block, the switches, the daily clean-up and the change-of-company clear
    // take the same rows in the same order, so none of them can wait on this one while it waits on them.
    for (const address of [oldEmail, newEmail].sort()) await lockEmail(tx, address);
    const [me] = await tx.select({ blocked: parent.blocked }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
    // What stops it, read again under the person's row (the guard read it only as the confirm began): a session ended
    // since (signed out, a block, any end of it) or a block means the address is not changed. Thrown, so the spend
    // goes back with the rest.
    const stopIfSignedOut = async () => {
      if (!me || me.blocked) throw new NotFinished(me ? "blocked" : "person_gone");
      const [session] = await tx.select({ id: parentAuthSession.id }).from(parentAuthSession).where(eq(parentAuthSession.id, ctx.sessionId));
      if (!session) throw new NotFinished("session_ended");
    };
    if (!(await spend(row.id, tx))) {
      // A request already spent was finished by the confirmation that spent it: a second press of the button, say.
      // Nothing more is done or audited for it.
      const [still] = await tx.select({ id: parentEmailChange.id }).from(parentEmailChange).where(eq(parentEmailChange.id, row.id));
      if (still) return null;
      // Gone since it was read: a block, a removal, the change-of-company clear or a new ask deleted it. A block or
      // an end of the session is told as one; otherwise the link no longer works, as any other.
      await stopIfSignedOut();
      return "gone";
    }
    await stopIfSignedOut();
    // Someone else came to hold the new address since it was checked: the person keeps the address they have, and
    // signs in with it as before. The parent is told the outcome, never why.
    if (await heldByAnother(tx, newEmail, ctx.parentId)) {
      await failed("address_taken", tx);
      return "taken";
    }
    await tx.update(parent).set({ email: newEmail, updatedAt: new Date() }).where(eq(parent.id, ctx.parentId));
    await tx.update(parentAuthUser).set({ email: newEmail, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, ctx.parentId));
    // Another link asked for before this one must not work, nor a code, set-up link or reset link sent to the old
    // address; and every device remembered for the old address asks for the second step again (open question 36).
    // The password stays.
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, ctx.parentId), isNull(parentEmailChange.usedAt)));
    await deleteUnusedSigninCodes(ctx.parentId, tx);
    const linksDeleted = await deleteUnusedSigninLinks(ctx.parentId, tx);
    const devicesForgotten = await forgetDevices(ctx.parentId, tx);
    // Every session was proved with the old address: the person signs in again, with the new one.
    const sessionsEnded = await endParentSessions(ctx.parentId, tx);
    await writeAudit({ actor, action: "parent.email.save", targetType: "parent", targetId: ctx.parentId, before: { email: oldEmail },
      after: { email: newEmail, familyId: String(ctx.familyId), sessionsEnded, linksDeleted, devicesForgotten }, ip: ctx.ip }, tx);
    return "changed";
  });

  let outcome: "changed" | "taken" | "gone" | null;
  try {
    outcome = await finish().catch((e: unknown) => { if (worthAnotherTry(e)) return finish(); throw e; });
  } catch (e) {
    // Nothing changed, and the request was not spent: recorded on its own. A finish stopped because the session ended
    // or the person was blocked meanwhile (NotFinished) has its own code, and the one who pressed is told the change
    // wasn't made; any other failure is told to try again, which the link allows until it expires.
    const stopped = e instanceof NotFinished ? e.why : null;
    await failed(stopped ?? (typeof pgCode(e) === "string" ? `failed_${String(pgCode(e)).slice(0, 8)}` : "failed"));
    return { ok: false, errors: [stopped ? EMAIL_COPY.notMade : EMAIL_COPY.tryLater] };
  }

  // The new address can never be the person's here, so nothing is promised and nobody was signed out: the words are
  // the ones for a change the parent asks the club for, which say nothing of why.
  if (outcome === "taken") return { ok: false, errors: [EMAIL_COPY.askTheClub] };
  // The request was deleted between the first read and the transaction: the link no longer works.
  if (outcome === "gone") return refuse("bad_link", [EMAIL_COPY.linkNoGood]);
  // A second press, on a request another confirmation spent: told as that one was. When it changed the person's
  // address it ended their sessions; when it didn't (the address was taken), nothing is promised and nobody was signed
  // out, so this press is told to ask the club too.
  if (outcome === null && (await db.select({ email: parent.email }).from(parent).where(eq(parent.id, ctx.parentId)))[0]?.email !== newEmail) {
    return { ok: false, errors: [EMAIL_COPY.askTheClub] };
  }
  // What the parent is told depends on the outcome alone: the new address can sign in to this family now, or not yet.
  // The family the request was asked in, which liveRequest() matched to the session's own (ctx.familyId).
  const inFamily = (await enterableGuardianRows(ctx.parentId)).some((r) => r.familyId === row.familyId);
  return { ok: true, message: inFamily ? EMAIL_COPY.done(newEmail) : EMAIL_COPY.finishing, signedOut: true };
}

/** Whether a person other than `parentId` signs in with `email`, as the person or as their sign-in account. */
async function heldByAnother(q: Pick<typeof db, "select">, email: string, parentId: string): Promise<boolean> {
  const [person] = await q.select({ id: parent.id }).from(parent).where(and(eq(parent.email, email), ne(parent.id, parentId))).limit(1);
  if (person) return true;
  const [account] = await q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(and(eq(parentAuthUser.email, email), ne(parentAuthUser.parentId, parentId))).limit(1);
  return account !== undefined;
}
