// The links an unlink ended whose customer is still in the books (stage 4's slice M3b2 of
// docs/superpowers/specs/2026-11-18-app-owned-families-design.md: after an unlink, no press makes a second customer in
// the books for a family, student or guardian whose customer is still there). One read, endedLinksHeld(), for
// "Create in QuickBooks and link" and the family create prepare() sends (src/lib/roster/writes.ts), a guardian's
// Parent customer create there, a family's page and the Families list. It reads any family's history and any
// customer of the roster cache, so it is staff code only, never imported by a parent page (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). It imports nothing of src/lib/roster/writes.ts or ./mapping.ts, so the
// roster's writes may import it with no cycle.
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, qboCustomer } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { getRosterSource } from "@/lib/roster/source";

/**
 * A record's ended link whose customer the books still hold: the customer's id, and from the roster cache its display
 * name (QuickBooks text, shown as text only), the customer it is directly under, its type and whether it is active;
 * and when the link ended.
 */
export type EndedHeld = { customerId: string; customerName: string; parentQboId: string | null; typeQboId: string | null; active: boolean; endedAt: Date };
/** What endedLinksHeld() answers, by record: only the records it holds an ended link of for. */
export type EndedLinksHeld = { families: Map<AppFamilyId, EndedHeld>; students: Map<AppStudentId, EndedHeld>; guardians: Map<string, EndedHeld> };

/**
 * For each record given (family records, student records, guardian rows) that has no live link of its kind in the
 * roster's company (getRosterSource(); nothing at all while it names none), its latest ended link in that company (by
 * `ended_at`, then the link's id), answered only when the roster cache (`qbo_customer`) holds that link's customer and
 * no live link of the same kind in that company names the customer now. So a record whose old customer has since been
 * linked to another record of its kind, or that the books no longer hold (deleted or merged in QuickBooks, gone from
 * the cache at the next read), is answered nothing: it is a record with no link like any other.
 *
 * Two queries whatever the number of records (the roster's company, then one query for every record of every kind),
 * none when every list is empty. Read in the caller's transaction when given one (under its roster lock, for a press).
 */
export async function endedLinksHeld(records: { families?: readonly AppFamilyId[]; students?: readonly AppStudentId[]; guardians?: readonly string[] }, tx?: Tx): Promise<EndedLinksHeld> {
  const out: EndedLinksHeld = { families: new Map(), students: new Map(), guardians: new Map() };
  const families = [...new Set(records.families ?? [])], students = [...new Set(records.students ?? [])], guardians = [...new Set(records.guardians ?? [])];
  if (families.length === 0 && students.length === 0 && guardians.length === 0) return out;
  const realmId = await getRosterSource(tx);
  if (realmId === null) return out;
  const q = tx ?? db;
  const e = accountingLinkEnded, l = accountingLink;
  const given: SQL[] = [
    ...(families.length ? [inArray(e.familyId, families)] : []),
    ...(students.length ? [inArray(e.studentId, students)] : []),
    ...(guardians.length ? [inArray(e.guardianId, guardians)] : []),
  ];
  // One record per row: exactly one of the three is set (accounting_link_ended_one_record), and uuids never collide.
  const record = sql`coalesce(${e.familyId}, ${e.studentId}, ${e.guardianId})`;
  // Each record's latest ended link, among the records with no live link of their kind in the company.
  const latest = q.selectDistinctOn([record], { familyId: e.familyId, studentId: e.studentId, guardianId: e.guardianId, customerId: e.customerId, endedAt: e.endedAt })
    .from(e)
    .where(and(eq(e.system, QUICKBOOKS), eq(e.realmId, realmId), or(...given),
      sql`not exists (select 1 from ${l} where ${l.system} = ${QUICKBOOKS} and ${l.realmId} = ${realmId}
        and (${l.familyId} = ${e.familyId} or ${l.studentId} = ${e.studentId} or ${l.guardianId} = ${e.guardianId}))`))
    .orderBy(record, desc(e.endedAt), desc(e.id))
    .as("latest");
  // Only those whose customer the cache holds, with no live link of the same kind naming it now.
  const rows = await q.select({ familyId: latest.familyId, studentId: latest.studentId, guardianId: latest.guardianId, customerId: latest.customerId, endedAt: latest.endedAt,
    customerName: qboCustomer.displayName, parentQboId: qboCustomer.parentQboId, typeQboId: qboCustomer.typeQboId, active: qboCustomer.active })
    .from(latest)
    .innerJoin(qboCustomer, eq(qboCustomer.qboId, latest.customerId))
    .where(sql`not exists (select 1 from ${l} where ${l.system} = ${QUICKBOOKS} and ${l.realmId} = ${realmId} and ${l.customerId} = ${latest.customerId}
      and (case when ${latest.familyId} is not null then ${l.familyId} is not null when ${latest.studentId} is not null then ${l.studentId} is not null
        else ${l.guardianId} is not null end))`);
  for (const r of rows) {
    const held: EndedHeld = { customerId: r.customerId, customerName: r.customerName, parentQboId: r.parentQboId, typeQboId: r.typeQboId, active: r.active, endedAt: r.endedAt };
    if (r.familyId !== null) out.families.set(r.familyId, held);
    else if (r.studentId !== null) out.students.set(r.studentId, held);
    else if (r.guardianId !== null) out.guardians.set(r.guardianId, held);
  }
  return out;
}
