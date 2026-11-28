// Parent-facing (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts): the queueing of a change of a
// guardian's phone and mailing address, a parent's own or (since stage 3's slice 11c) a staff member's, in the
// transaction that saves it (./contact-edits.ts), and, since stage 3's slice S11e, of a parent's confirmed change of
// their sign-in email, in the confirm's own transaction (./email-change.ts). It imports nothing staff-only and nothing from the QuickBooks client,
// and sends nothing: the write queue's worker sends each item at its next wake, and a staff member's is first tried at
// once after the save's commit, each through the one try of a change saved first (trySavedItem(),
// src/lib/roster/writes.ts). Whose details they are, and
// so which records they go to, comes from the caller, which took it from the session (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { family, guardian, qboCustomer, writeQueue, type ContactDetails, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getShape } from "@/lib/roster/shape";
import { familyLinkOf, guardianLinksOf, recordsCompany } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { whoseDetails } from "./my-family";
import type { DetailsEvents } from "@/lib/families/events";

/** Whose details a save changes: a person's own (books with a parent type), or an app family's (books with none). */
export type DetailsOf = { kind: "person"; parentId: string } | { kind: "family"; familyId: AppFamilyId };
type ContactWrite = Extract<RosterWrite, { op: "contact" }>;
type EmailWrite = Extract<RosterWrite, { op: "email" }>;
type Field = keyof ContactDetails;
const FIELDS: readonly Field[] = ["phone", "address"];
/** The note an earlier change is closed with when a later one of the same details takes its place (here, and once a later one is done or kept). */
export const CONTACT_REPLACED_NOTE = "Replaced by a later change to the same details.";
/**
 * How a staff member's save queues its changes (stage 3's slice 11c): as a change saved first is held for its at-once
 * try (queueSaved() in src/lib/roster/writes.ts), due only once its lease has run out (`nextTryAt`), asked by the staff
 * member (`askedBy`). A parent's save gives none: its items are due at once, asked by nobody on staff.
 */
export type QueueAs = { askedBy: string; nextTryAt: Date };
/** A QuickBooks customer id, by the client's own rule (isQboId()): digits only. Nothing else is ever queued to be sent. */
const isCustomerId = (id: string) => /^\d{1,19}$/.test(id);

/** One record a change goes to: its customer, the link's version, the membership (none for a family's), the family it is filed under. */
type Target = { role: ContactWrite["role"]; qboId: string; syncToken: string; guardianId: string | null; familyId: AppFamilyId };

/**
 * The records a person's or a family's details go to, by the records' company (none while it is unknown): for a
 * person, the own Parent customer of each of their open memberships in an active family record (its guardian link,
 * customerOfGuardian()'s rule, and no other open membership linked to the same customer), in books with a parent type;
 * for a family, its own linked customer (the member's own in flat books), in books with no parent type. A customer
 * whose id isn't digits is never one, nor one the roster cache holds inactive (as slice 9h sends nothing to one: open
 * question 12), which would only be kept at every save. Whether each is still the record's own when it is sent is the
 * sender's to check.
 */
async function targetsOf(tx: Tx, of: DetailsOf): Promise<{ realmId: string; targets: Target[] } | null> {
  return withoutInactive(tx, await recordTargetsOf(tx, of));
}
/** The records found, but those whose customer the roster cache holds inactive. */
async function withoutInactive(tx: Tx, found: { realmId: string; targets: Target[] } | null): Promise<{ realmId: string; targets: Target[] } | null> {
  if (found === null || !found.targets.length) return found;
  const inactive = new Set((await tx.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
    .where(and(inArray(qboCustomer.qboId, found.targets.map((t) => t.qboId)), eq(qboCustomer.active, false)))).map((c) => c.qboId));
  return { realmId: found.realmId, targets: found.targets.filter((t) => !inactive.has(t.qboId)) };
}
/** targetsOf()'s records, before the roster cache is asked which of their customers it holds inactive. */
async function recordTargetsOf(tx: Tx, of: DetailsOf): Promise<{ realmId: string; targets: Target[] } | null> {
  const realmId = await recordsCompany(tx);
  if (realmId === null) return null;
  const shape = await getShape(tx);
  if (shape === null) return null;
  if (of.kind === "person") {
    if (whoseDetails(shape) !== "person" || shape.kind !== "layered" || shape.parentTypeId === null) return null;
    const rows = await tx.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
      .where(and(eq(guardian.parentId, of.parentId), ne(guardian.status, "disabled"), eq(family.active, true))).orderBy(asc(guardian.id));
    const links = await guardianLinksOf(rows.map((r) => r.id), tx);
    const targets = rows.flatMap((r): Target[] => {
      const link = links.get(r.id);
      if (!link || link.openRows !== 1 || r.familyId === null || !isCustomerId(link.customerId)) return [];
      return [{ role: "parent", qboId: link.customerId, syncToken: link.syncedToken ?? "", guardianId: r.id, familyId: r.familyId }];
    });
    return { realmId, targets };
  }
  if (whoseDetails(shape) !== "family") return null;
  const link = await familyLinkOf(of.familyId, tx);
  if (!link || !isCustomerId(link.customerId)) return { realmId, targets: [] };
  return { realmId, targets: [{ role: shape.kind === "flat" ? "member" : "family", qboId: link.customerId, syncToken: link.syncedToken ?? "", guardianId: null, familyId: of.familyId }] };
}

/** The fields one set of details holds, as an item carries them. */
const pick = (d: ContactDetails, fields: readonly Field[]): ContactDetails =>
  Object.fromEntries(fields.filter((f) => d[f] !== undefined).map((f) => [f, d[f]])) as ContactDetails;

/**
 * Queues a saved change of a person's or a family's phone and mailing address, in the save's own transaction (the lead's
 * decisions 1 to 3 for stage 3's slice 11b): one change saved first (waiting, never sent, its next try now) for each
 * record it goes to (targetsOf()), filed under the membership's family (or the family), its target that customer, its
 * company the records'. `saved` is what the save changed: `change`, those fields as the portal holds them now; `was`,
 * as it held them before; `now`, every field as the portal holds it now. Returns the new items' ids, for the save's
 * audit row.
 *
 * A later change takes the place of an earlier one, never refused: each contact change of the same customer and
 * membership that is kept refused, or waiting or stuck and never sent (`sent` false, conditioned in the update itself,
 * so a sender that has marked one as maybe sent keeps it; one a sender holds locked at this moment is left alone, read
 * as one that may have been sent), is closed as given up (`roster.write.replaced`). One that may have been sent is left
 * to finish, and the new item accepts what each such change asked for as what QuickBooks may hold (`orWas`, every one
 * of them). The new item carries the portal's values now of every field any open change of the record asked for, the
 * ones that may have been sent included (so closing them once it is done or kept loses nothing), and the oldest
 * before-value of each among them, so it always says what QuickBooks last held by the portal's knowledge. It takes no
 * roster lock and no "being sent" lock, and waits for none. `o.queueAs`, for a staff member's save (QueueAs): its items
 * are held for the at-once try that follows the commit, and the worker takes one once its lease has run out.
 */
export async function queueContactChange(tx: Tx, of: DetailsOf, saved: { change: ContactDetails; was: ContactDetails; now: Required<ContactDetails> },
  o: { actor: Actor; ip: string | null; queueAs?: QueueAs }): Promise<string[]> {
  const found = await targetsOf(tx, of);
  if (found === null) return [];
  const ids: string[] = [];
  for (const t of found.targets) {
    const sameRecord = and(eq(writeQueue.realmId, found.realmId), eq(writeQueue.targetQboId, t.qboId), sql`${writeQueue.request}->>'op' = 'contact'`,
      t.guardianId === null ? sql`${writeQueue.request}->>'guardianId' is null` : sql`${writeQueue.request}->>'guardianId' = ${t.guardianId}`);
    const open = await tx.select().from(writeQueue).where(and(sameRecord, inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).orderBy(asc(writeQueue.createdAt), asc(writeQueue.id));
    // Those this save may close: not locked by a sender at this moment (skipped, never waited for).
    const free = new Set(open.length ? (await tx.select({ id: writeQueue.id }).from(writeQueue).where(inArray(writeQueue.id, open.map((r) => r.id))).for("update", { skipLocked: true })).map((r) => r.id) : []);
    const replaced: ContactWrite[] = [];
    const maybeSent: ContactWrite[] = [];
    for (const r of open) {
      const w = r.request as ContactWrite;
      const [gone] = free.has(r.id) && (r.state === "refused" || !r.sent)
        ? await tx.update(writeQueue).set({ state: "given_up", note: CONTACT_REPLACED_NOTE, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(writeQueue.id, r.id), eq(writeQueue.state, r.state), r.state === "refused" ? undefined : eq(writeQueue.sent, false))).returning({ id: writeQueue.id })
        : [];
      if (gone) {
        replaced.push(w);
        await writeAudit({ actor: o.actor, action: "roster.write.replaced", ip: o.ip, targetType: "write_queue", targetId: r.id,
          before: { state: r.state, code: r.lastCode }, after: { state: "given_up", replacedBy: { op: "contact" } } }, tx);
      } else maybeSent.push(w);
    }
    // Every field this save or any open change of the record asked for (one that may have been sent included, so that
    // once this one is done or kept and closes it, closeEarlierContacts(), nothing it asked for is lost), at the portal's
    // value now; each before-value the oldest of every open change of the record (what QuickBooks held before them, if
    // none landed), else the portal's value before this save.
    const oldestFirst = open.map((r) => r.request as ContactWrite);
    const fields = FIELDS.filter((f) => saved.change[f] !== undefined || oldestFirst.some((w) => w.change[f] !== undefined));
    const was: ContactDetails = {};
    for (const f of fields) {
      const first = oldestFirst.find((w) => w.was[f] !== undefined);
      const value = first ? first.was[f] : saved.was[f];
      if (value !== undefined) Object.assign(was, { [f]: value });
    }
    // What QuickBooks may hold instead: what each change that may have been sent asked for, and what each open change
    // already accepted so (its own `orWas`), every one of them, for the fields this one sends.
    const seen = new Set<string>();
    const orWas = [...maybeSent.map((w) => w.change), ...oldestFirst.flatMap((w) => w.orWas ?? [])].flatMap((d) => {
      const e = pick(d, fields.filter((f) => d[f] !== undefined));
      const key = JSON.stringify(e);
      if (!Object.keys(e).length || seen.has(key)) return [];
      seen.add(key);
      return [e];
    });
    const write: ContactWrite = { op: "contact", role: t.role, qboId: t.qboId, syncToken: t.syncToken, change: pick(saved.now, fields), was,
      ...(orWas.length ? { orWas } : {}), ...(t.guardianId !== null ? { guardianId: t.guardianId } : {}) };
    const [item] = await tx.insert(writeQueue).values({
      realmId: found.realmId, request: write, targetQboId: t.qboId, familyId: t.familyId, studentId: null,
      state: "waiting", sent: false, tries: 0, lastCode: null, nextTryAt: o.queueAs?.nextTryAt ?? new Date(), askedBy: o.queueAs?.askedBy ?? null, askedByLabel: o.actor.label,
    }).returning({ id: writeQueue.id });
    ids.push(item!.id);
  }
  return ids;
}

/**
 * The records a person's sign-in email goes to (stage 3's slice S11e; app-owned families spec, Appendix B: "A guardian
 * in two families has a Parent customer under each in QuickBooks, so their one sign-in email is sent to two records"),
 * by the records' company (none while it is unknown): in layered books with a parent type, the own Parent customer of
 * each of their open memberships in an active family record (recordTargetsOf()'s rule for a person's details); in books
 * with no parent type (whoseDetails() says the family's: flat books included), each such membership's family's own
 * linked customer, the family's (layered) or the member's own (flat). Each carries the membership it is for
 * (`guardianId`), a family's too. Never a customer whose id isn't digits, nor one the roster cache holds inactive.
 */
async function emailTargetsOf(tx: Tx, parentId: string): Promise<{ realmId: string; targets: Target[] } | null> {
  const realmId = await recordsCompany(tx);
  if (realmId === null) return null;
  const shape = await getShape(tx);
  if (shape === null) return null;
  if (whoseDetails(shape) === "person") return withoutInactive(tx, await recordTargetsOf(tx, { kind: "person", parentId }));
  const rows = await tx.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"), eq(family.active, true))).orderBy(asc(guardian.id));
  const targets: Target[] = [];
  for (const r of rows) {
    if (r.familyId === null) continue;
    const link = await familyLinkOf(r.familyId, tx);
    if (!link || !isCustomerId(link.customerId)) continue;
    targets.push({ role: shape.kind === "flat" ? "member" : "family", qboId: link.customerId, syncToken: link.syncedToken ?? "", guardianId: r.id, familyId: r.familyId });
  }
  return withoutInactive(tx, { realmId, targets });
}

/**
 * Who asked, as an email item names it on Reconciliation's and a family's lists ("by the parent"): never the actor's
 * label, which for a parent is their sign-in address, here the one they have just given up. Those lists write no audit
 * row and show no address (the lead's decision 5 for slice S11e); the compare view, audited, is where an address is shown.
 */
export const EMAIL_ASKED_BY = "the parent";

/**
 * Queues a parent's confirmed change of their sign-in email, in the confirm's own transaction, after the person's
 * address is changed (stage 3's slice S11e; the lead's decision 1): one change saved first (waiting, never sent, its next
 * try now, asked by nobody on staff) for each record it goes to (emailTargetsOf()), filed under the membership's family,
 * its target that customer, its company the records'. `from` is the person's sign-in address before the change, `to`
 * after it. Returns the new items' ids, for `parent.email.save`.
 *
 * A later change takes the place of an earlier one, by queueContactChange()'s rule: each change of sign-in email of the
 * same customer and membership that is kept refused, or waiting or stuck and never sent (`sent` false, conditioned in the
 * update itself; one a sender holds locked at this moment is left alone, read as one that may have been sent), is
 * closed as given up (`roster.write.replaced`). One that may have been sent is left to finish, and the new item accepts
 * its `to` (and its `orFrom`) as what QuickBooks may hold instead (`orFrom`). The new item's `from` is the oldest of
 * every open change of the record (what QuickBooks held before them, if none landed), else the person's address before
 * this change. A change that would come back to the address the oldest one replaced queues nothing. It takes no roster
 * lock and no "being sent" lock and waits for neither: it reads and writes the queue's rows after the person's row, in
 * the order lockedPerson() (./sessions.ts) gives. Its inserts take a key share on each membership's family row (the
 * foreign key), which can wait briefly for a staff write holding that row FOR UPDATE; the comment above lockedPerson()
 * says why that is safe, and what a new writer must not do.
 */
export async function queueEmailChange(tx: Tx, parentId: string, change: { from: string; to: string }, o: { actor: Actor; ip: string | null }): Promise<string[]> {
  const found = await emailTargetsOf(tx, parentId);
  if (found === null) return [];
  const to = change.to.trim().toLowerCase();
  const ids: string[] = [];
  for (const t of found.targets) {
    const sameRecord = and(eq(writeQueue.realmId, found.realmId), eq(writeQueue.targetQboId, t.qboId), sql`${writeQueue.request}->>'op' = 'email'`,
      t.guardianId === null ? sql`${writeQueue.request}->>'guardianId' is null` : sql`${writeQueue.request}->>'guardianId' = ${t.guardianId}`);
    const open = await tx.select().from(writeQueue).where(and(sameRecord, inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).orderBy(asc(writeQueue.createdAt), asc(writeQueue.id));
    // Those this change may close: not locked by a sender at this moment (skipped, never waited for).
    const free = new Set(open.length ? (await tx.select({ id: writeQueue.id }).from(writeQueue).where(inArray(writeQueue.id, open.map((r) => r.id))).for("update", { skipLocked: true })).map((r) => r.id) : []);
    const maybeSent: EmailWrite[] = [];
    for (const r of open) {
      const [gone] = free.has(r.id) && (r.state === "refused" || !r.sent)
        ? await tx.update(writeQueue).set({ state: "given_up", note: CONTACT_REPLACED_NOTE, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(writeQueue.id, r.id), eq(writeQueue.state, r.state), r.state === "refused" ? undefined : eq(writeQueue.sent, false))).returning({ id: writeQueue.id })
        : [];
      if (gone) {
        await writeAudit({ actor: o.actor, action: "roster.write.replaced", ip: o.ip, targetType: "write_queue", targetId: r.id,
          before: { state: r.state, code: r.lastCode }, after: { state: "given_up", replacedBy: { op: "email" } } }, tx);
      } else maybeSent.push(r.request as EmailWrite);
    }
    // The oldest before-value of every open change of the record (one that may have been sent included): what QuickBooks
    // held before them, if none of them landed.
    const from = (open.length ? (open[0]!.request as EmailWrite).from : change.from).trim().toLowerCase();
    // What QuickBooks may hold instead: what each change that may have been sent asked for, and what each open change
    // already accepted so, every one of them, but the two the item names.
    const orFrom = [...new Set([...maybeSent.map((w) => w.to), ...open.flatMap((r) => (r.request as EmailWrite).orFrom ?? [])].map((a) => a.trim().toLowerCase()))]
      .filter((a) => a !== "" && a !== from && a !== to);
    // Back to the address the oldest open change replaced, with nothing that may have been sent: nothing to send.
    if (from === to && !orFrom.length) continue;
    const write: EmailWrite = { op: "email", role: t.role, qboId: t.qboId, syncToken: t.syncToken, from, to,
      ...(orFrom.length ? { orFrom } : {}), ...(t.guardianId !== null ? { guardianId: t.guardianId } : {}) };
    const [item] = await tx.insert(writeQueue).values({
      realmId: found.realmId, request: write, targetQboId: t.qboId, familyId: t.familyId, studentId: null,
      state: "waiting", sent: false, tries: 0, lastCode: null, nextTryAt: new Date(), askedBy: null, askedByLabel: EMAIL_ASKED_BY,
    }).returning({ id: writeQueue.id });
    ids.push(item!.id);
  }
  return ids;
}

/**
 * QuickBooks' handler of the core's details events (`records.events`, src/lib/families/events.ts; slice P6): each event
 * queues exactly what the save queued before it had events, by the two functions above, with the same arguments, in the
 * save's own transaction.
 */
export const QUICKBOOKS_DETAILS_EVENTS: DetailsEvents = {
  contact: (tx, e, o) => queueContactChange(tx, e.of, { change: e.change, was: e.was, now: e.now }, o),
  email: (tx, e, o) => queueEmailChange(tx, e.parentId, { from: e.from, to: e.to }, o),
};
