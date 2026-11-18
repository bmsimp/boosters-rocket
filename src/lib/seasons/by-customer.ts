// The season's chosen lists, ticks and waivers read by customer, for the areas still keyed by QuickBooks ids (forms;
// stage 2 of the app-owned families spec). The season keeps them by the app's own ids; each row is translated through
// its record's link, of the kind the row holds (a family's through its family link, a student's through its student
// link), in the company the records were made from, and a row whose record has no link there is left out. The reads
// that use these are the forms' matrix and reminders (./everyone.ts, staff only): a boundary AGENTS.md lists (Seasons),
// which goes when forms move to the app's ids. Volunteering, which has moved, reads the season by the app's ids
// (./season-rows.ts). Nothing here reads a row, so parent code may import it.
import "server-only";
import { and, eq, or, type AnyColumn } from "drizzle-orm";
import { accountingLink, requirementProgress } from "@/lib/db/schema";
import { QUICKBOOKS } from "@/lib/families/ids";

/** The link of a row's family or student, whichever it holds: one row of accounting_link at most, in that company. */
export const linkOfSubject = (realmId: string, subject: { familyId: AnyColumn; studentId: AnyColumn }) =>
  and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId),
    or(eq(accountingLink.familyId, subject.familyId), eq(accountingLink.studentId, subject.studentId)));

/** The columns of requirement_progress, by customer, joined with linkOfSubject(). */
export const CUSTOMER_RECORDED_COLUMNS = {
  requirementId: requirementProgress.requirementId, subjectQboId: accountingLink.customerId, metAt: requirementProgress.metAt, metBy: requirementProgress.metBy,
  waivedAt: requirementProgress.waivedAt, waivedBy: requirementProgress.waivedBy, waivedReason: requirementProgress.waivedReason,
};
