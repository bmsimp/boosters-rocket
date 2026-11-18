// The season's chosen lists, ticks and waivers read by customer, for the areas still keyed by QuickBooks ids
// (volunteering, forms, buy-outs, money; stage 2 of the app-owned families spec). The season keeps them by the app's own
// ids; each row here is translated through its record's link, of the kind the row holds (a family's through its family
// link, a student's through its student link), in the company the records were made from, and a row whose record has
// no link there is left out. Like the season's own reads (./recorded.ts) it reads only the families and students it is
// asked about, or everyone (null) for staff, so parent code may import it. Each caller is a boundary AGENTS.md lists
// (Seasons): it goes when its area moves to the app's ids.
import "server-only";
import { and, eq, inArray, or, type AnyColumn } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, requirementCover, requirementProgress } from "@/lib/db/schema";
import { QUICKBOOKS } from "@/lib/families/ids";
import { recordsCompany } from "@/lib/families/links";
import type { CustomerRecorded } from "./customer-keys";

/** The link of a row's family or student, whichever it holds: one row of accounting_link at most, in that company. */
const linkOfSubject = (realmId: string, subject: { familyId: AnyColumn; studentId: AnyColumn }) =>
  and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId),
    or(eq(accountingLink.familyId, subject.familyId), eq(accountingLink.studentId, subject.studentId)));

/**
 * The chosen lists of these requirements by requirement id, as customer ids. With `subjectQboIds`, only the entries
 * whose family or student is linked to one of them are read: a parent's query passes its own family and students.
 */
export async function loadCustomerCovers(requirementIds: readonly string[], subjectQboIds: readonly string[] | null, tx?: Tx): Promise<Map<string, string[]>> {
  const covers = new Map<string, string[]>();
  if (requirementIds.length === 0 || subjectQboIds?.length === 0) return covers;
  const realmId = await recordsCompany(tx);
  if (realmId === null) return covers;
  const rows = await (tx ?? db).select({ requirementId: requirementCover.requirementId, customerId: accountingLink.customerId }).from(requirementCover)
    .innerJoin(accountingLink, linkOfSubject(realmId, requirementCover))
    .where(and(inArray(requirementCover.requirementId, [...requirementIds]), subjectQboIds ? inArray(accountingLink.customerId, [...subjectQboIds]) : undefined));
  for (const r of rows) covers.set(r.requirementId, [...(covers.get(r.requirementId) ?? []), r.customerId]);
  return covers;
}

/** What requirement_progress holds for these requirements and, when given, only the families or students linked to these customers. */
export async function loadCustomerRecorded(requirementIds: readonly string[], subjectQboIds: readonly string[] | null, tx?: Tx): Promise<CustomerRecorded[]> {
  if (requirementIds.length === 0 || subjectQboIds?.length === 0) return [];
  const realmId = await recordsCompany(tx);
  if (realmId === null) return [];
  return (tx ?? db).select({
    requirementId: requirementProgress.requirementId, subjectQboId: accountingLink.customerId, metAt: requirementProgress.metAt, metBy: requirementProgress.metBy,
    waivedAt: requirementProgress.waivedAt, waivedBy: requirementProgress.waivedBy, waivedReason: requirementProgress.waivedReason,
  }).from(requirementProgress)
    .innerJoin(accountingLink, linkOfSubject(realmId, requirementProgress))
    .where(and(inArray(requirementProgress.requirementId, [...requirementIds]), subjectQboIds ? inArray(accountingLink.customerId, [...subjectQboIds]) : undefined));
}
