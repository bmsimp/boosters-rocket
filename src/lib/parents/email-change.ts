// Parent-facing: a parent changes the address they sign in with (v1 spec §6.2, parents spec §2 Email changes).
// QuickBooks is the only home of a sign-in address (parents spec, decision 6), so the change is written there first,
// and the portal follows QuickBooks' answer through the reconcile, which decides access by its own rules.
// Privacy: whose record is decided by loadMyRecord() from the session's ParentCtx and nothing else. The token a link
// carries is untrusted: it is found by its hash, and only among the requests of the session's own person, link, family
// and record. This module is in the staff-only import scan (tests/integration/page-guards.test.ts), and it is the only
// one that may name the client's email write, qboUpdateCustomerEmail (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, parent, parentEmailChange, qboConnection, qboCustomer } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { env } from "@/env";
import { normalizeEmail } from "@/lib/email";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { emailChangeConfirmMessage, emailChangeNoticeMessage } from "@/lib/mail/messages";
import { EMAIL_UPDATE, faultCodeOf, isQboId, qboCustomerById, qboUpdateCustomerEmail } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { fieldHasChange, replaceAddressInField } from "./email-field";
import { parseEmailField } from "./emails";
import { loadMyRecord, type MyRecord } from "./my-family";
import { takeRateLimit } from "./rate-limit";
import { reconcileAccess } from "./reconcile";
import { askForRosterRefresh } from "./refresh-ask";
import { deleteUnusedSigninCodes, endParentSessions, lockEmail, parentActor } from "./sessions";
import { getParentSettings } from "./settings";

/** How long the link mailed to the new address works. */
export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long one read from QuickBooks may take while a parent waits (the whole read: one and a half times that), and the write. */
const READ_TIMEOUT_MS = 4_000;
const WRITE_TIMEOUT_MS = 8_000;
/** How long the portal waits for the roster lock once QuickBooks has the change. A refresh can hold it for minutes. */
const LOCK_WAIT_MS = 3_000;

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
  tryLater: "We couldn't reach the club's books just now, so nothing was changed. Please open the link again in a little while.",
  changed: "Your details changed in the club's books just now, so nothing was changed. Please open the link again to try once more.",
  unsure: "We couldn't tell whether the change was made. Please open the link again in a little while to check.",
  booksChanged: "The club's books have changed since you asked, so nothing was changed. Please ask the club to change your sign-in email.",
  cantHere: "That change can't be made here, so nothing was changed. Please ask the club to change your sign-in email.",
  notAccepted: "The club's books wouldn't take that address, so nothing was changed. Please ask the club for help.",
  done: (email: string) => `Done. From now on, sign in with ${email}.`,
  /** When the change is in QuickBooks and the new address can't sign in to this family yet, whatever the reason. */
  finishing: "The change is made in the club's books. The club will finish setting up your sign-in with the new address.",
} as const;

export type EmailResult = { ok: true; message: string } | { ok: false; errors: string[] };
/** After a confirmation that was made, the person's sessions have ended: `signedOut` says so, so the page offers the sign-in page. */
export type ConfirmResult = { ok: true; message: string; signedOut: true } | { ok: false; errors: string[] };

const actorOf = (ctx: ParentCtx) => parentActor({ id: ctx.parentId, email: ctx.email });
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** A token as this module makes them: 32 random bytes, URL-safe base64. Anything else is never looked up. */
const isToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const isRow = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The address of the link mailed to the new address: the portal's own address, then the token. */
export const emailChangeLink = (token: string) => `${env.APP_URL.replace(/\/+$/, "")}/family/email/${token}`;

/**
 * Who else must agree, beside the record: parent sign-ins switched on (the reconcile follows nothing while they are
 * off), and the person's open links all to this one family. A person whose address is on records of more than one
 * family would be split by changing one of them, so they ask the club.
 */
async function othersAllow(ctx: ParentCtx): Promise<boolean> {
  const [settings, links] = await Promise.all([
    getParentSettings(),
    db.select({ familyQboId: guardian.familyQboId }).from(guardian).where(and(eq(guardian.parentId, ctx.parentId), ne(guardian.status, "disabled"))),
  ]);
  return settings.signin && links.length > 0 && links.every((l) => l.familyQboId === ctx.familyQboId);
}

/** The session's own record when this person may change their sign-in address here; null when they ask the club. */
async function mayChange(ctx: ParentCtx): Promise<MyRecord | null> {
  const [record, allowed] = await Promise.all([loadMyRecord(ctx), othersAllow(ctx)]);
  return record && allowed ? record : null;
}

/**
 * Whether the signed-in parent may change their sign-in address from the portal: their sign-in comes from a QuickBooks
 * record of their own (MyContact.edits, the same rule as "Update my details"), parent sign-ins are on, and they are in
 * no other family. Otherwise the pages offer nothing, and the email page tells them to ask the club.
 */
export async function canChangeMyEmail(ctx: ParentCtx): Promise<boolean> {
  return (await mayChange(ctx)) !== null;
}

/**
 * Asks for the change: stores it, and mails a link to the new address and a notice to the old one. Nothing else
 * changes. `input` is what the browser sent, untrusted. The answer is the same whatever the new address is: whether
 * anyone in the portal or in QuickBooks has it is never said. An earlier request of the person that wasn't used is
 * replaced, so only the newest link works.
 */
export async function requestMyEmailChange(ctx: ParentCtx, input: unknown): Promise<EmailResult> {
  const refused = async (code: string, errors: string[], record?: MyRecord | null): Promise<EmailResult> => {
    await writeAudit({ actor: actorOf(ctx), action: "parent.email.request.failed", ...(record ? { targetType: "qbo_customer", targetId: record.qboId } : {}), after: { code }, ip: ctx.ip });
    return { ok: false, errors };
  };
  const take = await takeRateLimit("email_request_parent", ctx.parentId);
  if (take === "refused") return { ok: false, errors: [EMAIL_COPY.tooManyAsks] };
  if (take === "first_refusal") return refused("rate_limited", [EMAIL_COPY.tooManyAsks]);

  const email = typeof input === "string" && input.length <= 320 ? normalizeEmail(input) : null;
  if (!email) return { ok: false, errors: [EMAIL_COPY.invalid] };
  if (email === ctx.email.trim().toLowerCase()) return { ok: false, errors: [EMAIL_COPY.same] };
  const record = await mayChange(ctx);
  if (!record) return refused("not_offered", [EMAIL_COPY.askTheClub]);

  const token = randomBytes(32).toString("base64url");
  const actor = actorOf(ctx);
  await db.transaction(async (tx) => {
    // The person's row first, as every change of a person's sign-in does: two asks at once end with one live request.
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, ctx.parentId), isNull(parentEmailChange.usedAt)));
    await tx.insert(parentEmailChange).values({ parentId: ctx.parentId, guardianId: ctx.guardianId, familyQboId: ctx.familyQboId, recordQboId: record.qboId,
      newEmail: email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) });
    await writeAudit({ actor, action: "parent.email.request", targetType: "qbo_customer", targetId: record.qboId, before: { email: ctx.email }, after: { email }, ip: ctx.ip }, tx);
  });
  const brand = await currentBrand();
  const sent = await sendMail(emailChangeConfirmMessage(brand, email, { link: emailChangeLink(token) }), { purpose: "email_change_confirm", actor, ip: ctx.ip });
  if (!sent.ok) return { ok: false, errors: [EMAIL_COPY.notSent] };
  await sendMail(emailChangeNoticeMessage(brand, ctx.email), { purpose: "email_change_notice", actor, ip: ctx.ip });
  return { ok: true, message: EMAIL_COPY.sent(email) };
}

type Request = typeof parentEmailChange.$inferSelect;

/** The live request this token is for, made by the session's own person under the session's own link and family. */
async function liveRequest(ctx: ParentCtx, token: unknown): Promise<Request | null> {
  if (!isToken(token)) return null;
  const [row] = await db.select().from(parentEmailChange).where(and(
    eq(parentEmailChange.tokenHash, hashToken(token)), isNull(parentEmailChange.usedAt), gt(parentEmailChange.expiresAt, new Date()),
    eq(parentEmailChange.parentId, ctx.parentId), eq(parentEmailChange.guardianId, ctx.guardianId), eq(parentEmailChange.familyQboId, ctx.familyQboId)));
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
 * the session's own requests, and must still be for the session's own record.
 */
export async function findMyEmailChange(ctx: ParentCtx, token: unknown): Promise<EmailLinkView> {
  const row = await liveRequest(ctx, token);
  if (!row) return { state: "gone" };
  const record = await mayChange(ctx);
  if (!record) return { state: "ask_club" };
  return record.qboId === row.recordQboId ? { state: "ask", newEmail: row.newEmail } : { state: "gone" };
}

/**
 * Never the wrong company, as for a parent's phone and address: QuickBooks is connected, and to the company the roster
 * cache (and so this person's customer id) was read from. The write checks the company again as it is sent.
 */
async function connectedCompany(): Promise<string | null> {
  const [[connection], source] = await Promise.all([
    db.select({ realmId: qboConnection.realmId, connected: sql<boolean>`${qboConnection.refreshTokenCiphertext} is not null` }).from(qboConnection),
    getRosterSource(),
  ]);
  return connection?.realmId && connection.connected && source === connection.realmId ? connection.realmId : null;
}

type Live = { ok: true; field: string | null; version: string } | { ok: false; code: string };
/**
 * The email field and version of a customer QuickBooks sent, when it is still this person's record as the roster has
 * it: the one asked for, active, under the same family, of a type that makes it theirs. One moved, made inactive or
 * retyped is not theirs to change, whatever the cache still says (as for the phone and address, ./contact-edits.ts).
 */
function liveOf(customer: Record<string, unknown> | null, record: MyRecord): Live {
  if (!customer || customer.Id !== record.qboId) return { ok: false, code: "bad_answer" };
  if (customer.Active !== true && customer.Active !== "true") return { ok: false, code: "inactive" };
  const under = isRow(customer.ParentRef) ? str(customer.ParentRef.value) || null : null;
  if (under !== record.parentQboId) return { ok: false, code: "moved" };
  if (!record.typeQboIds.includes(isRow(customer.CustomerTypeRef) ? str(customer.CustomerTypeRef.value) : "")) return { ok: false, code: "retyped" };
  const version = customer.SyncToken;
  if (typeof version !== "string" || !/^\d{1,20}$/.test(version)) return { ok: false, code: "bad_answer" };
  const field = isRow(customer.PrimaryEmailAddr) && typeof customer.PrimaryEmailAddr.Address === "string" ? customer.PrimaryEmailAddr.Address : null;
  return { ok: true, field, version };
}

/**
 * After these the portal can't know whether QuickBooks made the change: the update went, and what came back was
 * nothing, or nothing to rely on (as for the phone and address). Every other failure means nothing was changed.
 */
const mayHaveChanged = (code: string): boolean => code === "timeout" || code === "unreachable" || code === "bad_answer" || /^http_5\d\d(_|$)/.test(code);
/** Postgres could not take a lock in time (lock_not_available). Drizzle wraps the driver's error, so its cause is read too. */
const lockNotAvailable = (e: unknown): boolean => {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  return code(e) === "55P03" || code((e as { cause?: unknown } | null)?.cause) === "55P03";
};
class NotThisCompany extends Error {}

/**
 * Confirms the change the link was mailed for. `token` comes from the browser, untrusted: it must be a live request of
 * the session's own person, link and family, for the session's own record (loadMyRecord), or the answer is the same
 * as for a link that has expired. The record changed is that one, never one named by the browser.
 *
 * QuickBooks first. The record is read live; it must still be the person's own, and its email field must still hold
 * the address they sign in with by the rule that gives them the sign-in (the first address on a person's own record,
 * any on a family's). That one address is replaced wherever it appears in the field (./email-field.ts), and only the
 * email field is sent, with the version just read, so a change made in QuickBooks meanwhile is refused and nothing is
 * overwritten. A field that already reads as the change made (the answer to an earlier try was lost) is taken as made.
 *
 * Then the portal, only after QuickBooks has said yes: in one transaction, holding the roster lock (waiting a few
 * seconds at most), the cache takes QuickBooks' answer and the reconcile decides access by its own rules: the person's
 * address changes in place, or the link moves to whoever has the new address, or the address is held for staff. When
 * the lock isn't free the cache is left alone and the worker is asked to read the roster at its next wake. Either way
 * the person's sessions end and their unused sign-in codes go, so the old address signs in nowhere from that moment,
 * and the change is audited with the address before and after.
 *
 * A token is spent when the change is made, or when it can never succeed. After a failure that changed nothing
 * (QuickBooks out of reach or busy, the record changed meanwhile, an answer the portal can't tell about) it works
 * again until it expires.
 */
export async function confirmMyEmailChange(ctx: ParentCtx, token: unknown, o: { timeoutMs?: number; lockWaitMs?: number } = {}): Promise<ConfirmResult> {
  const actor = actorOf(ctx);
  const refuse = async (code: string, errors: string[], target?: string | null): Promise<ConfirmResult> => {
    await writeAudit({ actor, action: "parent.email.save.failed", ...(target ? { targetType: "qbo_customer", targetId: target } : {}), after: { code: code.slice(0, 40) }, ip: ctx.ip });
    return { ok: false, errors };
  };
  const spend = (id: string, tx?: Tx) => (tx ?? db).update(parentEmailChange).set({ usedAt: new Date() }).where(and(eq(parentEmailChange.id, id), isNull(parentEmailChange.usedAt)));

  // Counted first, so that whatever follows (an audit row for each refusal among it) is bounded per person.
  const take = await takeRateLimit("email_confirm_parent", ctx.parentId);
  if (take === "refused") return { ok: false, errors: [EMAIL_COPY.tooManyTries] };
  if (take === "first_refusal") return refuse("rate_limited", [EMAIL_COPY.tooManyTries]);

  const row = await liveRequest(ctx, token);
  if (!row) return refuse("bad_link", [EMAIL_COPY.linkNoGood]);
  const record = await loadMyRecord(ctx);
  if (!record || record.qboId !== row.recordQboId) {
    // Another record is theirs now: this request can never be confirmed. No record at all may come back (a roster read
    // under way), so that one is left for another try.
    if (record) await spend(row.id);
    return refuse("not_their_record", [EMAIL_COPY.linkNoGood], row.recordQboId);
  }
  if (!(await othersAllow(ctx))) return refuse("not_offered", [EMAIL_COPY.askTheClub], record.qboId);
  const realmId = await connectedCompany();
  if (!realmId) return refuse("not_connected", [EMAIL_COPY.tryLater], record.qboId);
  // An id that isn't digits is never sent to QuickBooks (the browser run's seeded records are such ids).
  if (!isQboId(record.qboId)) return refuse("bad_id", [EMAIL_COPY.tryLater], record.qboId);

  const readMs = o.timeoutMs ?? READ_TIMEOUT_MS;
  let live: Live;
  try {
    live = liveOf(await qboCustomerById(record.qboId, { timeoutMs: readMs, signal: AbortSignal.timeout(readMs * 1.5), retry: true, failFast: true, realmId }), record);
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    return refuse(e.code, [EMAIL_COPY.tryLater], record.qboId);
  }
  if (!live.ok) {
    if (live.code === "bad_answer") return refuse(live.code, [EMAIL_COPY.tryLater], record.qboId);
    await spend(row.id);
    return refuse(live.code, [EMAIL_COPY.booksChanged], record.qboId);
  }

  const oldEmail = ctx.email.trim().toLowerCase(), newEmail = row.newEmail;
  const firstOnly = record.signsInBy === "first";
  let answer: { field: string | null; version: string; updatedAt: Date | null } | null;
  if (fieldHasChange(live.field, oldEmail, newEmail, firstOnly)) {
    answer = { field: live.field, version: live.version, updatedAt: null }; // an earlier try made it: nothing is sent
  } else {
    const signsIn = parseEmailField(live.field).usable;
    if (!(firstOnly ? signsIn.slice(0, 1) : signsIn).includes(oldEmail)) {
      // The club took the address off the record, or put another before it: the sign-in it gave is ending.
      await spend(row.id);
      return refuse("not_in_field", [EMAIL_COPY.booksChanged], record.qboId);
    }
    const change = replaceAddressInField(live.field, oldEmail, newEmail);
    if (!change.ok) {
      await spend(row.id);
      return refuse(change.reason, [EMAIL_COPY.cantHere], record.qboId);
    }
    let sent: Record<string, unknown>;
    try {
      const writeMs = o.timeoutMs ?? WRITE_TIMEOUT_MS;
      sent = await qboUpdateCustomerEmail(record.qboId, live.version, change.field, { realmId, timeoutMs: writeMs, signal: AbortSignal.timeout(writeMs * 1.5) });
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      const fault = faultCodeOf(e);
      // Someone changed the record between the read and the write: QuickBooks kept theirs, and the link works again.
      if (fault === EMAIL_UPDATE.faults.stale) return refuse("stale", [EMAIL_COPY.changed], record.qboId);
      if (fault !== null && EMAIL_UPDATE.faults.validation.test(fault)) {
        await spend(row.id);
        return refuse(e.code, [EMAIL_COPY.notAccepted], record.qboId);
      }
      return refuse(e.code, [mayHaveChanged(e.code) ? EMAIL_COPY.unsure : EMAIL_COPY.tryLater], record.qboId);
    }
    const back = liveOf(sent, record);
    const stamped = isRow(sent.MetaData) && typeof sent.MetaData.LastUpdatedTime === "string" ? Date.parse(sent.MetaData.LastUpdatedTime) : NaN;
    // QuickBooks said yes. An answer that doesn't read as this person's record with the change made is not put in the
    // cache: the refresh asked for below brings the record in as QuickBooks has it.
    answer = back.ok && fieldHasChange(back.field, oldEmail, newEmail, firstOnly)
      ? { field: back.field, version: back.version, updatedAt: Number.isNaN(stamped) ? null : new Date(stamped) } : null;
  }

  // QuickBooks has the change. From here the request is spent, whatever happens to the portal's copy.
  const audit = (tx: Tx, after: Record<string, unknown>) => writeAudit({ actor, action: "parent.email.save", targetType: "qbo_customer", targetId: record.qboId,
    before: { email: oldEmail, field: live.field }, after: { email: newEmail, ...after }, ip: ctx.ip }, tx);
  // The cache is left alone, and the worker reads the roster again at its next wake: never a refresh in this request.
  const leaveToTheRefresh = (code: string) => db.transaction(async (tx) => {
    await spend(row.id, tx);
    await askForRosterRefresh(tx);
    const sessionsEnded = await endOldSignIns(tx, ctx.parentId, oldEmail);
    await audit(tx, { field: answer?.field ?? null, portal: "refresh_asked", code, sessionsEnded });
  });
  if (!answer) {
    await leaveToTheRefresh("answer_unread");
  } else {
    const { field, version, updatedAt } = answer;
    try {
      await db.transaction(async (tx) => {
        // Never the long wait a refresh can cause: a few seconds, then the refresh is left to bring the change in.
        await tx.execute(sql.raw(`set local lock_timeout = '${Math.max(1, Math.floor(o.lockWaitMs ?? LOCK_WAIT_MS))}ms'`));
        await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
        // After a change of company the id names another customer there, or nothing.
        if ((await getRosterSource(tx)) !== realmId) throw new NotThisCompany();
        // Spent before the reconcile, which deletes a person's unused requests when it changes their address.
        await spend(row.id, tx);
        // As the roster refresh stores an email field: trimmed and lower-cased, at most 320 characters.
        await tx.update(qboCustomer).set({ email: field?.trim().slice(0, 320).toLowerCase() || null, syncToken: version, ...(updatedAt ? { qboUpdatedAt: updatedAt } : {}) })
          .where(eq(qboCustomer.qboId, record.qboId));
        const r = await reconcileAccess(tx, { cause: `parent.email.save#${row.id}` });
        const sessionsEnded = await endOldSignIns(tx, ctx.parentId, oldEmail);
        await audit(tx, { field, portal: "reconciled", emailChanged: r.emailChanged, ended: r.ended, granted: r.granted, sessionsEnded });
      });
    } catch (e) {
      await leaveToTheRefresh(lockNotAvailable(e) ? "busy" : e instanceof NotThisCompany ? "other_company" : "cache_failed");
    }
  }

  // What the parent is told depends on the outcome alone: the new address can sign in to this family now, or not yet.
  const [open] = await db.select({ id: guardian.id }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(eq(parent.email, newEmail), eq(parent.blocked, false), eq(guardian.familyQboId, ctx.familyQboId), ne(guardian.status, "disabled"))).limit(1);
  return { ok: true, message: open ? EMAIL_COPY.done(newEmail) : EMAIL_COPY.finishing, signedOut: true };
}

/**
 * Ends every session of the person and deletes their unused sign-in codes, under the lock that claims of the old
 * address take and the person's row, in that order (./sessions.ts). Their sessions were proved with the old address.
 */
async function endOldSignIns(tx: Tx, parentId: string, oldEmail: string): Promise<number> {
  await lockEmail(tx, oldEmail);
  await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, parentId)).for("update");
  await deleteUnusedSigninCodes(parentId, tx);
  return endParentSessions(parentId, tx);
}
