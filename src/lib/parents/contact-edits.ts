// Parent-facing: a parent reads and changes their own phone and mailing address in QuickBooks (v1 spec §6.2, §6.3).
// Privacy: which record is decided by loadMyRecord() from the session's ParentCtx and nothing else. Nothing a browser
// sends ever names a customer: the form carries the new values and the version it was shown, never an id. This module
// is in the staff-only import scan (tests/integration/page-guards.test.ts), and it is the only one that may import
// the client's one write, qboUpdateCustomerContact (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboConnection, qboCustomer } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { CUSTOMER_UPDATE, faultCodeOf, isQboId, qboCustomerById, qboUpdateCustomerContact, type CustomerContactChange } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { getRosterSource } from "@/lib/roster/source";
import { asShown, fieldErrors, parseContactForm, sameAddress, samePhone, type ContactForm, type ContactValues } from "./contact-fields";
import { parseEmailField } from "./emails";
import { loadMyRecord, type MyContact, type MyRecord } from "./my-family";
import { takeRateLimit } from "./rate-limit";
import { parentActor } from "./sessions";

/** How long one read from QuickBooks may take while a parent waits (the whole read: one and a half times that), and the write. */
const READ_TIMEOUT_MS = 4_000;
const WRITE_TIMEOUT_MS = 8_000;

export const CONTACT_COPY = {
  saved: "Saved. The club's books have your new details.",
  nothingChanged: "Those are the details the club already has, so there was nothing to change.",
  changed: "Your details changed in the club's books while you were editing, so nothing was saved. Here they are as they stand now. Please make your change again.",
  changedUnseen: "Your details changed in the club's books while you were editing, so nothing was saved. Please open this page again to see them as they stand now.",
  tryLater: "We couldn't reach the club's books just now, so nothing was changed. Please try again in a little while.",
  unsure: "We couldn't tell whether your details were saved. Please open this page again in a little while to check.",
  notAccepted: "The club's books wouldn't take those details, so nothing was changed. Please check them and try again, or ask the club for help.",
  tooMany: "You've saved your details a few times in the last hour. Please wait a little while before trying again.",
  askTheClub: "These details can't be changed here. Please ask the club and they'll update them.",
} as const;

type Failed = { ok: false; code: string };
const failed = (code: string): Failed => ({ ok: false, code });
const isRow = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.normalize("NFC").trim() : "");
/** One of QuickBooks' values as the form shows it: one line that a browser sends back as it was given (asShown). */
const shown = (v: unknown): string => (typeof v === "string" ? asShown(v) : "");
const actorOf = (ctx: ParentCtx) => parentActor({ id: ctx.parentId, email: ctx.email });

/**
 * Never the wrong company, as for a family's money: QuickBooks is connected, and to the company the roster cache (and
 * so this person's customer id) was read from. Each request then checks the company again as it is sent.
 */
async function connectedCompany(): Promise<{ ok: true; realmId: string } | Failed> {
  const [[connection], source] = await Promise.all([
    db.select({ realmId: qboConnection.realmId, connected: sql<boolean>`${qboConnection.refreshTokenCiphertext} is not null` }).from(qboConnection),
    getRosterSource(),
  ]);
  if (!connection?.realmId || !connection.connected) return failed("not_connected");
  if (source === null || source !== connection.realmId) return failed("other_company");
  return { ok: true, realmId: connection.realmId };
}

/**
 * The phone and billing address on a customer QuickBooks sent, as the form shows them. The form has two address lines:
 * any further ones are shown on the second. Each value is written as the one line a form field can hold (asShown).
 * These are the values a save compares with what came back from the browser, to find what the parent changed: a value
 * shown here must come back from an untouched field exactly as it is here.
 */
function valuesOf(customer: Record<string, unknown>): ContactValues {
  const phone = isRow(customer.PrimaryPhone) ? shown(customer.PrimaryPhone.FreeFormNumber) : "";
  const a = isRow(customer.BillAddr) ? customer.BillAddr : {};
  return {
    phone, line1: shown(a.Line1), line2: [a.Line2, a.Line3, a.Line4, a.Line5].map(shown).filter(Boolean).join(", "),
    city: shown(a.City), region: shown(a.CountrySubDivisionCode), postalCode: shown(a.PostalCode), country: shown(a.Country),
  };
}

/** Who a record is checked for: the roster's record of it, and the address the signed-in person signed in with. */
type Mine = { record: MyRecord; email: string };

/**
 * What the form shows of a customer QuickBooks sent, or why not. This answer is newer than the roster cache, which is
 * read once a day, and newer than the sign-in, which was decided from that cache. So the record must be this person's
 * as QuickBooks has it now, whatever the cache still says: the one asked for, still active, still where the cache has
 * it (one moved to another family is not theirs to change), and its email field must still hold the address they
 * signed in with, by the rule that gave them the sign-in (./access-rules.ts): the first address on a parent's own
 * record, any address on a family's. When the club takes a parent's address off a record, the next roster read ends
 * that sign-in; until it does, nothing the record holds now is shown to them, and they change none of it.
 */
function formOf(customer: Record<string, unknown> | null, { record, email }: Mine): { ok: true; form: ContactForm } | Failed {
  if (!customer || customer.Id !== record.qboId) return failed("bad_answer");
  if (customer.Active !== true && customer.Active !== "true") return failed("inactive");
  const under = isRow(customer.ParentRef) ? str(customer.ParentRef.value) || null : null;
  if (under !== record.parentQboId) return failed("moved");
  const field = isRow(customer.PrimaryEmailAddr) && typeof customer.PrimaryEmailAddr.Address === "string" ? customer.PrimaryEmailAddr.Address : null;
  const addresses = parseEmailField(field).usable;
  if (!(record.signsInBy === "every" ? addresses : addresses.slice(0, 1)).includes(email.trim().toLowerCase())) return failed("not_theirs");
  const version = customer.SyncToken;
  if (typeof version !== "string" || !/^\d{1,20}$/.test(version)) return failed("bad_answer");
  return { ok: true, form: { values: valuesOf(customer), version } };
}

/** One read of the person's own record from QuickBooks. An id that isn't digits is never sent. */
async function readLive(mine: Mine, realmId: string, timeoutMs: number): Promise<{ ok: true; form: ContactForm } | Failed> {
  const { record } = mine;
  if (!isQboId(record.qboId)) return failed("bad_id");
  try {
    return formOf(await qboCustomerById(record.qboId, { timeoutMs, signal: AbortSignal.timeout(timeoutMs * 1.5), retry: true, failFast: true, realmId }), mine);
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    return failed(e.code);
  }
}

export type ContactView =
  /** No QuickBooks record of their own (a sign-in made by hand), or a family the portal may not show: nothing to edit. */
  | { state: "none" }
  /** Their record, but QuickBooks couldn't be asked just now: what the roster last had, and no form. */
  | { state: "unavailable"; me: MyContact }
  /** Their record as QuickBooks has it now. */
  | { state: "ok"; me: MyContact; form: ContactForm };

/**
 * The signed-in parent's phone and address for the edit page, read from QuickBooks as the page opens: the roster
 * cache keeps no address, on purpose. A parent reading their own details is not audited.
 */
export async function loadMyContact(ctx: ParentCtx, o: { timeoutMs?: number } = {}): Promise<ContactView> {
  const record = await loadMyRecord(ctx);
  if (!record) return { state: "none" };
  const unavailable: ContactView = { state: "unavailable", me: record.contact };
  const company = await connectedCompany();
  if (!company.ok || !isQboId(record.qboId)) return unavailable;
  const take = await takeRateLimit("contact_open_parent", ctx.parentId);
  if (take !== "taken") {
    if (take === "first_refusal") await writeAudit({ actor: actorOf(ctx), action: "parent.contact.read.refused", targetType: "qbo_customer", targetId: record.qboId, after: { code: "rate_limited" }, ip: ctx.ip });
    return unavailable;
  }
  const live = await readLive({ record, email: ctx.email }, company.realmId, o.timeoutMs ?? READ_TIMEOUT_MS);
  return live.ok ? { state: "ok", me: record.contact, form: live.form } : unavailable;
}

/**
 * `current`, when given, is the record as QuickBooks has it now: the form shows it in place of what was typed.
 * Otherwise the shape every action returns (AGENTS.md).
 */
export type SaveContactResult = { ok: true; message: string; current: ContactForm } | { ok: false; errors: string[]; current?: ContactForm };

/** What the audit log keeps of a change: only the part that changed, phone or address. */
const auditValues = (v: ContactValues, change: CustomerContactChange) => ({
  ...(change.phone !== undefined ? { phone: v.phone } : {}),
  ...(change.address !== undefined ? { address: { line1: v.line1, line2: v.line2, city: v.city, region: v.region, postalCode: v.postalCode, country: v.country } } : {}),
});
/** After these the portal can't know whether QuickBooks made the change. Every other failure means it did not. */
const mayHaveSaved = (code: string): boolean => code === "timeout" || code === "unreachable" || code === "bad_answer" || /^http_5\d\d$/.test(code);

/**
 * Saves the signed-in parent's phone and address to QuickBooks. `input` is what the browser sent, untrusted: it is
 * read whole (parseContactForm) and holds no id. The record changed is the session's own (loadMyRecord).
 *
 * The record is read from QuickBooks first. If its version is not the one the form was shown, nothing is sent: the
 * parent is told it changed and given the values as they stand (v1 spec §6.3). Otherwise only what differs is sent,
 * with that version; if QuickBooks finds the record changed in the moment between, it refuses, and the answer is the
 * same. Nothing is tried twice and nothing is overwritten.
 *
 * What differs is found by comparing what the browser sent with the record as the form shows it (valuesOf). The
 * versions match, so that is what this form was shown, and a field the parent left alone comes back as it went. Only
 * the fields that differ are checked for length and characters (fieldErrors): QuickBooks can hold a city longer than
 * the portal lets a parent type, and a parent who changes their phone is not asked to fix it. When any part of the
 * address differs the whole address is sent as the parent saw it, an untouched part that is too long included;
 * QuickBooks holds that already, and says so itself if it won't take it.
 *
 * A save is audited with the before and after values, in the transaction that brings the roster cache's phone and
 * SyncToken up to date from QuickBooks' answer. A save that was refused or failed is audited with its short code.
 */
export async function saveMyContact(ctx: ParentCtx, input: unknown, o: { timeoutMs?: number } = {}): Promise<SaveContactResult> {
  const refuse = async (code: string, errors: string[], record?: MyRecord, current?: ContactForm): Promise<SaveContactResult> => {
    await writeAudit({ actor: actorOf(ctx), action: "parent.contact.save.failed", ...(record ? { targetType: "qbo_customer", targetId: record.qboId } : {}),
      after: { code: code.slice(0, 40) }, ip: ctx.ip });
    return { ok: false, errors, ...(current ? { current } : {}) };
  };

  // Counted first, so that whatever follows (an audit row for each refusal among it) is bounded per person.
  const take = await takeRateLimit("contact_save_parent", ctx.parentId);
  if (take === "refused") return { ok: false, errors: [CONTACT_COPY.tooMany] };
  if (take === "first_refusal") return refuse("rate_limited", [CONTACT_COPY.tooMany]);

  const parsed = parseContactForm(input);
  if (!parsed.ok) return refuse("invalid", parsed.errors); // not this form at all: nothing is asked of QuickBooks
  const { values, version } = parsed.form;

  const record = await loadMyRecord(ctx);
  if (!record) return refuse("no_record", [CONTACT_COPY.askTheClub]);
  const company = await connectedCompany();
  if (!company.ok) return refuse(company.code, [CONTACT_COPY.tryLater], record);
  const readMs = o.timeoutMs ?? READ_TIMEOUT_MS;
  const mine: Mine = { record, email: ctx.email };
  const before = await readLive(mine, company.realmId, readMs);
  if (!before.ok) return refuse(before.code, [CONTACT_COPY.tryLater], record);
  if (before.form.version !== version) return refuse("stale", [CONTACT_COPY.changed], record, before.form);
  const errors = fieldErrors(values, before.form.values);
  if (errors.length) return refuse("invalid", errors, record);

  const change: CustomerContactChange = {
    ...(samePhone(values, before.form.values) ? {} : { phone: values.phone }),
    ...(sameAddress(values, before.form.values) ? {} : { address: { line1: values.line1, line2: values.line2, city: values.city, region: values.region, postalCode: values.postalCode, country: values.country } }),
  };
  if (change.phone === undefined && change.address === undefined) return { ok: true, message: CONTACT_COPY.nothingChanged, current: before.form };

  let answer: Record<string, unknown>;
  try {
    const writeMs = o.timeoutMs ?? WRITE_TIMEOUT_MS;
    answer = await qboUpdateCustomerContact(record.qboId, version, change, { realmId: company.realmId, timeoutMs: writeMs, signal: AbortSignal.timeout(writeMs * 1.5) });
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const fault = faultCodeOf(e);
    if (fault === CUSTOMER_UPDATE.faults.stale) {
      // Someone changed the record between the read above and the write: QuickBooks kept theirs. Read it again to show it.
      const now = await readLive(mine, company.realmId, readMs);
      // If that read fails too, the parent is not told that what they typed is what the books hold.
      return now.ok ? refuse("stale", [CONTACT_COPY.changed], record, now.form) : refuse("stale", [CONTACT_COPY.changedUnseen], record);
    }
    if (fault !== null && CUSTOMER_UPDATE.faults.validation.test(fault)) return refuse(e.code, [CONTACT_COPY.notAccepted], record);
    return refuse(e.code, [mayHaveSaved(e.code) ? CONTACT_COPY.unsure : CONTACT_COPY.tryLater], record);
  }

  const after = formOf(answer, mine);
  // QuickBooks said yes and sent something the portal can't read back: the change was probably made.
  if (!after.ok) return refuse(after.code === "bad_answer" ? "bad_answer" : `answer_${after.code}`, [CONTACT_COPY.unsure], record);
  const updatedAt = isRow(answer.MetaData) && typeof answer.MetaData.LastUpdatedTime === "string" ? Date.parse(answer.MetaData.LastUpdatedTime) : NaN;
  await db.transaction(async (tx) => {
    // The cache row is brought up to date only while the cache is still this company's: after a change of company the
    // id names another customer there, or nothing.
    if ((await getRosterSource(tx)) === company.realmId) {
      await tx.update(qboCustomer).set({ phone: after.form.values.phone.slice(0, 50) || null, syncToken: after.form.version, ...(Number.isNaN(updatedAt) ? {} : { qboUpdatedAt: new Date(updatedAt) }) })
        .where(eq(qboCustomer.qboId, record.qboId));
    }
    await writeAudit({ actor: actorOf(ctx), action: "parent.contact.save", targetType: "qbo_customer", targetId: record.qboId,
      before: auditValues(before.form.values, change), after: auditValues(after.form.values, change), ip: ctx.ip }, tx);
  });
  return { ok: true, message: CONTACT_COPY.saved, current: after.form };
}
