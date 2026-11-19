// Parent-facing: a parent changes the address they sign in with (v1 spec §6.2, parents spec §2 Email changes).
// The change is still written to QuickBooks first, and never queued: the parent is waiting. Once QuickBooks has it, the
// portal changes the person's own sign-in address itself (stage 3 of the app-owned families spec: a sign-in email is
// the app's record), and takes QuickBooks' answer into the roster cache when the roster is free.
// Privacy: whose record is decided by loadMyRecord() from the session's ParentCtx and nothing else. The token a link
// carries is untrusted: it is found by its hash, and only among the requests of the session's own person, link, family
// and record. This module is in the staff-only import scan (tests/integration/page-guards.test.ts), and it is the only
// one that may name the client's email write, qboUpdateCustomerEmail (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange, qboConnection } from "@/lib/db/schema";
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
import { takeEmailIntoCache } from "@/lib/roster/cache-email";
import { fieldHasChange, replaceAddressInField } from "./email-field";
import { parseEmailField } from "./emails";
import { loadMyRecord, type MyRecord } from "./my-family";
import { takeRateLimit } from "./rate-limit";
import { appRecordsAudit, noAppRecordChanges } from "@/lib/families/changes";
import { askForRosterRefresh } from "./refresh-ask";
import { deleteUnusedSigninCodes, endParentSessions, enterableGuardianRows, lockEmail, parentActor } from "./sessions";
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
  finishing: "The change is made in the club's books. Your new address will work for signing in within a few minutes: if it doesn't yet, please wait a little and try again.",
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
 * Who else must agree, beside the record: parent sign-ins switched on, and the person's open links all to this one family: the session's own guardian row is among their open rows,
 * and every open row of theirs names the session's family record (`guardian.family_id` is `ctx.familyId`, the app's
 * family the gate gave the session). A person whose address is on records of more than one family would be split by
 * changing one of them, so they ask the club; so does one with an open row that names no family record.
 */
async function othersAllow(ctx: ParentCtx): Promise<boolean> {
  const [settings, links] = await Promise.all([
    getParentSettings(),
    db.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian).where(and(eq(guardian.parentId, ctx.parentId), ne(guardian.status, "disabled"))),
  ]);
  return settings.signin && links.some((l) => l.id === ctx.guardianId) && links.every((l) => l.familyId === ctx.familyId);
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
    // The request is asked in the session's own family (the app's family record the gate gave it).
    await tx.insert(parentEmailChange).values({ parentId: ctx.parentId, guardianId: ctx.guardianId, familyId: ctx.familyId, recordQboId: record.qboId,
      newEmail: email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) });
    await writeAudit({ actor, action: "parent.email.request", targetType: "qbo_customer", targetId: record.qboId, before: { email: ctx.email },
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
 * overwritten. A field that already reads as the change made (the answer to an earlier try was lost, and the parent
 * was told the portal can't tell) is taken as made and nothing is sent again: this try finishes the portal's side, so
 * the two are never left apart while the link lives, and a new link for the same address finishes it after that. One
 * address is one person: an address another person signs in with is refused before anything is sent.
 *
 * Then the portal, only after QuickBooks has said yes, in one transaction. First the person, under both address locks
 * and the person's row (the order ./sessions.ts gives): their own address changes (`parent.email` and their sign-in
 * account's), their unused sign-in codes and other links go and their sessions end, so the old address signs in
 * nowhere from that moment. Then the roster cache takes QuickBooks' answer and the app's own records are brought into
 * step, holding the roster lock (waiting a few seconds at most), or, when the lock isn't free, the cache is left alone
 * and the worker is asked to read the roster at its next wake; the person's change stands either way. The change is
 * audited with the address before and after. Nothing here opens, moves or closes a guardian row: the person keeps the
 * families they had. Should another person have come to hold the new address since the check above (two links to one
 * address confirmed at once), the person keeps theirs, the audit row says QuickBooks holds the new one, and the parent
 * is told to ask the club: nothing is promised, and nobody is signed out.
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
  /** Marks the request used; false when it was no longer there to spend (another confirmation of the same link got to it first). */
  const spend = async (id: string, tx?: Tx): Promise<boolean> => (await (tx ?? db).update(parentEmailChange).set({ usedAt: new Date() })
    .where(and(eq(parentEmailChange.id, id), isNull(parentEmailChange.usedAt))).returning({ id: parentEmailChange.id })).length > 0;

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
    return refuse("not_their_record", [EMAIL_COPY.linkNoGood], record?.qboId);
  }
  if (!(await othersAllow(ctx))) return refuse("not_offered", [EMAIL_COPY.askTheClub], record.qboId);
  const realmId = await connectedCompany();
  if (!realmId) return refuse("not_connected", [EMAIL_COPY.tryLater], record.qboId);
  // An id that isn't digits is never sent to QuickBooks (the browser run's seeded records are such ids).
  if (!isQboId(record.qboId)) return refuse("bad_id", [EMAIL_COPY.tryLater], record.qboId);
  // One address is one person: one another person signs in with is never sent, and the words never say why.
  if (await heldByAnother(db, row.newEmail, ctx.parentId)) {
    await spend(row.id);
    return refuse("address_taken", [EMAIL_COPY.cantHere], record.qboId);
  }

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
  /** Whether this confirmation sent the write; false when an earlier one had already made the change. */
  let wrote = false;
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
      wrote = true;
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
    before: { email: oldEmail, field: live.field }, after: { email: newEmail, familyId: String(ctx.familyId), ...after }, ip: ctx.ip }, tx);
  const lockWait = Math.max(1, Math.floor(o.lockWaitMs ?? LOCK_WAIT_MS));
  const outcome = await db.transaction(async (tx): Promise<"changed" | "taken" | null> => {
    // The person first, under the locks every change of a sign-in address takes, in the order ./sessions.ts gives: both
    // addresses, then the person's row, and only then their links, codes and sessions. An ask and a block take the row
    // before the links too, so neither can wait on this one while it waits on them. The roster comes last: nothing
    // that holds the roster lock waits for a person's row.
    for (const address of [oldEmail, newEmail].sort()) await lockEmail(tx, address);
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
    // A change this call found made, on a request already spent, was finished by the confirmation that spent it: a second
    // press of the button, say. Nothing more is done or audited for it. A write this call sent is always audited.
    if (!(await spend(row.id, tx)) && !wrote) return null;
    // Someone else came to hold the new address since it was checked: the person keeps the address they have, and
    // signs in with it as before, though QuickBooks now holds the new one (the audit row says so, for staff to put the
    // record right). The parent is told the outcome, never why.
    const taken = await heldByAnother(tx, newEmail, ctx.parentId);
    let sessionsEnded = 0;
    if (!taken) {
      await tx.update(parent).set({ email: newEmail, updatedAt: new Date() }).where(eq(parent.id, ctx.parentId));
      await tx.update(parentAuthUser).set({ email: newEmail, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, ctx.parentId));
      // A code sent to the old address must not work, nor another link asked for before this one.
      await deleteUnusedSigninCodes(ctx.parentId, tx);
      await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, ctx.parentId), isNull(parentEmailChange.usedAt)));
      // Every session was proved with the old address: the person signs in again, with the new one.
      sessionsEnded = await endParentSessions(ctx.parentId, tx);
    }
    // Then the roster cache, in a savepoint: under the roster lock, never the long wait a refresh can cause (a few seconds,
    // then the worker is asked to read the roster at its next wake, never a refresh in this request), and only while
    // the cache is the company the change was written to (after a change of company the id names another customer).
    // QuickBooks holds the new address either way, so the cache takes it either way.
    let portal = "refresh_asked", code: string | null = answer ? null : "answer_unread";
    let appRecords = noAppRecordChanges();
    if (answer) {
      const took = answer;
      try {
        appRecords = await tx.transaction(async (sp) => {
          await sp.execute(sql.raw(`set local lock_timeout = '${lockWait}ms'`));
          await sp.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
          await sp.execute(sql`set local lock_timeout to default`);
          if ((await getRosterSource(sp)) !== realmId) throw new NotThisCompany();
          return takeEmailIntoCache(sp, { qboId: record.qboId, ...took });
        });
        portal = "cached";
      } catch (e) {
        code = lockNotAvailable(e) ? "busy" : e instanceof NotThisCompany ? "other_company" : "cache_failed";
      }
    }
    if (portal !== "cached") await askForRosterRefresh(tx);
    await audit(tx, taken
      ? { field: answer?.field ?? null, portal, ...(code ? { code } : {}), app: "address_taken", quickbooks: "holds_new_address", ...appRecordsAudit(appRecords) }
      : { field: answer?.field ?? null, portal, ...(code ? { code } : {}), app: "changed", sessionsEnded, ...appRecordsAudit(appRecords) });
    return taken ? "taken" : "changed";
  });

  // The new address can never be the person's here, so nothing is promised and nobody was signed out: the words are
  // the ones for a change the parent asks the club for, which say nothing of why.
  if (outcome === "taken") return { ok: false, errors: [EMAIL_COPY.askTheClub] };
  // What the parent is told depends on the outcome alone: the new address can sign in to this family now, or not yet.
  // The family the request was asked in, which liveRequest() matched to the session's own (ctx.familyId). A second press
  // that found the change finished by the first is told as the first was.
  const made = outcome === "changed" || ((await db.select({ email: parent.email }).from(parent).where(eq(parent.id, ctx.parentId)))[0]?.email === newEmail);
  const inFamily = made && (await enterableGuardianRows(ctx.parentId)).some((r) => r.familyId === row.familyId);
  return { ok: true, message: inFamily ? EMAIL_COPY.done(newEmail) : EMAIL_COPY.finishing, signedOut: true };
}

/** Whether a person other than `parentId` signs in with `email`, as the person or as their sign-in account. */
async function heldByAnother(q: Pick<typeof db, "select">, email: string, parentId: string): Promise<boolean> {
  const [person] = await q.select({ id: parent.id }).from(parent).where(and(eq(parent.email, email), ne(parent.id, parentId))).limit(1);
  if (person) return true;
  const [account] = await q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(and(eq(parentAuthUser.email, email), ne(parentAuthUser.parentId, parentId))).limit(1);
  return account !== undefined;
}
