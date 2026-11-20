// Parent-facing (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts): the queueing of a parent's change of
// their phone and mailing address, in the transaction that saves it (./contact-edits.ts). It imports nothing staff-only
// and nothing from the QuickBooks client, and sends nothing: the write queue's worker sends each item at its next wake,
// through the one try of a change saved first (trySavedItem(), src/lib/roster/writes.ts). Whose details they are, and
// so which records they go to, comes from the caller, which took it from the session (tests/unit/quickbooks-writes.test.ts).
import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { family, guardian, writeQueue, type ContactDetails, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getShape } from "@/lib/roster/shape";
import { familyLinkOf, guardianLinksOf, recordsCompany } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { whoseDetails } from "./my-family";

/** Whose details a save changes: a person's own (books with a parent type), or an app family's (books with none). */
export type DetailsOf = { kind: "person"; parentId: string } | { kind: "family"; familyId: AppFamilyId };
type ContactWrite = Extract<RosterWrite, { op: "contact" }>;
type Field = keyof ContactDetails;
const FIELDS: readonly Field[] = ["phone", "address"];
/** A QuickBooks customer id, by the client's own rule (isQboId()): digits only. Nothing else is ever queued to be sent. */
const isCustomerId = (id: string) => /^\d{1,19}$/.test(id);

/** One record a change goes to: its customer, the link's version, the membership (none for a family's), the family it is filed under. */
type Target = { role: ContactWrite["role"]; qboId: string; syncToken: string; guardianId: string | null; familyId: AppFamilyId };

/**
 * The records a person's or a family's details go to, by the records' company (none while it is unknown): for a
 * person, the own Parent customer of each of their open memberships in an active family record (its guardian link,
 * customerOfGuardian()'s rule, and no other open membership linked to the same customer), in books with a parent type;
 * for a family, its own linked customer (the member's own in flat books), in books with no parent type. A customer
 * whose id isn't digits is never one. Whether each is still the record's own when it is sent is the sender's to check.
 */
async function targetsOf(tx: Tx, of: DetailsOf): Promise<{ realmId: string; targets: Target[] } | null> {
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
 * as one that may have been sent), is closed as given up (`roster.write.replaced`), and the new item carries the newest
 * values of every field any of them changed and the oldest before-value of each among every open change of the record,
 * so it always says what QuickBooks last held by the portal's knowledge. One that may have been sent is left to finish,
 * and the new item also accepts what it asked for as what QuickBooks may hold (`orWas`). It takes no roster lock and no "being sent" lock, and waits for none.
 */
export async function queueContactChange(tx: Tx, of: DetailsOf, saved: { change: ContactDetails; was: ContactDetails; now: Required<ContactDetails> }, o: { actor: Actor; ip: string | null }): Promise<string[]> {
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
        ? await tx.update(writeQueue).set({ state: "given_up", note: "Replaced by a later change to the same details.", nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(writeQueue.id, r.id), eq(writeQueue.state, r.state), r.state === "refused" ? undefined : eq(writeQueue.sent, false))).returning({ id: writeQueue.id })
        : [];
      if (gone) {
        replaced.push(w);
        await writeAudit({ actor: o.actor, action: "roster.write.replaced", ip: o.ip, targetType: "write_queue", targetId: r.id,
          before: { state: r.state, code: r.lastCode }, after: { state: "given_up", replacedBy: { op: "contact" } } }, tx);
      } else maybeSent.push(w);
    }
    // Every field this save or a replaced change asked for, at the portal's value now; each before-value the oldest of
    // every open change of the record (one that may have been sent included: what QuickBooks held before it, if it never
    // landed), else the portal's value before this save.
    const fields = FIELDS.filter((f) => saved.change[f] !== undefined || replaced.some((w) => w.change[f] !== undefined));
    const was: ContactDetails = {};
    const oldestFirst = open.map((r) => r.request as ContactWrite);
    for (const f of fields) {
      const first = oldestFirst.find((w) => w.was[f] !== undefined);
      const value = first ? first.was[f] : saved.was[f];
      if (value !== undefined) Object.assign(was, { [f]: value });
    }
    // What QuickBooks may hold instead: the newest change that may have been sent, field by field, else a replaced one's own.
    const orWas: ContactDetails = {};
    for (const f of fields) {
      const from = [...maybeSent].reverse().find((w) => w.change[f] !== undefined)?.change[f] ?? [...replaced].reverse().find((w) => w.orWas?.[f] !== undefined)?.orWas?.[f];
      if (from !== undefined) Object.assign(orWas, { [f]: from });
    }
    const write: ContactWrite = { op: "contact", role: t.role, qboId: t.qboId, syncToken: t.syncToken, change: pick(saved.now, fields), was,
      ...(Object.keys(orWas).length ? { orWas } : {}), ...(t.guardianId !== null ? { guardianId: t.guardianId } : {}) };
    const [item] = await tx.insert(writeQueue).values({
      realmId: found.realmId, request: write, targetQboId: t.qboId, familyId: t.familyId, studentId: null,
      state: "waiting", sent: false, tries: 0, lastCode: null, nextTryAt: new Date(), askedBy: null, askedByLabel: o.actor.label,
    }).returning({ id: writeQueue.id });
    ids.push(item!.id);
  }
  return ids;
}
