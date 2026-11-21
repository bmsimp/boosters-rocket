// The reviewed import's press (stage 4's slice M6 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4: "An admin reviews the list before anything is saved. Families made this way are linked from the start";
// "Every link, unlink, import and alignment is audited"; Appendix A's `accounting.import.save`): "Make these families"
// on the accounting links screen, for the families its review proposed (./import-proposals.ts) that staff left ticked.
// It reads every customer of the roster cache, every family's guardians and the persons who hold the proposed addresses,
// and gives addresses a family's sign-in, so it is staff code only, never imported by a parent page (STAFF_ONLY_IMPORTS
// in tests/integration/page-guards.test.ts).
//
// Two halves, the lead's decision 2: the families and students in one transaction under the roster lock held
// exclusively (lockRosterAs(), as every link press), all or nothing; then, after it commits, each guardian in a
// transaction of its own (importGuardian(), src/lib/parents/guardians.ts), whose locks come in lockedPerson()'s order,
// the person's before the roster lock, which the families' half holds first: so the two never share a transaction.
// Nothing is sent to QuickBooks and nothing is queued, in any books.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { importRecordsFromRoster } from "@/lib/families/roster-import";
import { importGuardian, type ImportGuardianResult, type Waits } from "@/lib/parents/guardians";
import { isQboId } from "@/lib/quickbooks/client";
import { handful, isSecondFamilyLink, NO_FAMILY_COPY } from "@/lib/roster/no-family";
import { madeAfterGivingUp } from "@/lib/roster/writes";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { IMPORT_MAX, importKeys, type ProposedFamily, type ProposedGuardian } from "./import-proposals";
import type { LinkDone, LinkOp } from "./link-writes";
import { customerAims, importProposalOf, readLinkBasics } from "./mapping";
import { importStampHolds } from "./stamp";

const no = (...errors: string[]): LinkDone => ({ ok: false, errors });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why a guardian of the import wasn't added, in words (the lead's decision 4: each sentence in one place). */
export const GUARDIAN_NOT_ADDED: Record<NotAdded, string> = {
  busy: "the portal was busy reading QuickBooks for longer than it waits",
  not_tried: "it wasn't tried, as the portal was busy reading QuickBooks",
  failed: "something went wrong in the portal as they were added, so nothing was saved for them",
  not_tried_failed: "it wasn't tried, as something went wrong in the portal adding an earlier guardian",
  taken: "someone else in the portal took that address meanwhile",
  moved: "the person who held that address changed it meanwhile",
  blocked: "the person who holds that address was blocked meanwhile",
  already: "they were a guardian of it already",
  removed: "they were added and removed again meanwhile",
  invalid: "the portal can't take that name or address",
  no_family: "the family wasn't there",
  inactive: "the family was made inactive meanwhile",
  waiting: "a change to the family waits on Reconciliation",
  making: "the family was being made in the books at that moment",
  changing: "the family was being changed in the books at that moment",
  other_company: "QuickBooks was connected to a different company meanwhile",
};

/** What staff read when the press doesn't go through, or after it. Nothing is ever made in the refusals. */
export const IMPORT_COPY = {
  notFromPage: "That didn't go through, and nothing was made. Reload the page and try again.",
  changed: "The families proposed changed since the list was shown. Nothing was made. The list is shown again as it is now: look it over, then press again.",
  families: (names: readonly string[]) => (names.length === 1 ? `1 family made in the portal and linked to its customer: ${handful(names)}.`
    : `${names.length} families made in the portal, each linked to its customer: ${handful(names)}.`),
  students: (made: number, leftAlone: number) => [made === 0 ? "No student was made." : `${plural(made, "student", "students")} made, each linked to their own customer.`,
    ...(leftAlone === 0 ? [] : [`${plural(leftAlone, "student under them already had a record in the portal and was", "students under them already had a record in the portal and were")} left as ${leftAlone === 1 ? "it was" : "they were"}.`])].join(" "),
  guardians: (added: number, fresh: number, reused: number) => (added === 0 ? "No guardian was added."
    : `${plural(added, "guardian", "guardians")} added, as on a family's page, for ${[fresh === 0 ? null : plural(fresh, "new person", "new people"),
      reused === 0 ? null : `${plural(reused, "person", "people")} the portal had already, their names as they were`].filter((x) => x !== null).join(" and ")}.`),
  linked: (linked: number, notLinked: number) => [linked === 0 ? null : `${plural(linked, "guardian was", "guardians were")} linked to their own Parent customer in the books.`,
    notLinked === 0 ? null : `${plural(notLinked, "guardian wasn't", "guardians weren't")} linked to the Parent customer the list showed, as it is linked to someone or a change waits for it now: link them in their family's row on this page.`].filter((x) => x !== null).join(" "),
  notAdded: (who: string, email: string, family: string, why: string) => `${who} (${email}) wasn't added to ${family}: ${why}. Add them on the family's page, under Families.`,
  /** Each sentence counts people, each once however many families they were added to, by where their welcome stands once added (ImportGuardianResult's `welcome`). */
  welcomes: (w: { owed: number; welcomedBefore: number; whileOff: number }) => [
    w.owed === 0 ? null : `${plural(w.owed, "person added is", "people added are")} owed an email with a link to set up their sign-in (a welcome, for anyone never welcomed): the portal sends a few at a time, so it can take a little while for everyone.`,
    w.whileOff === 0 ? null : `Welcome emails were off as they were added, so nobody was mailed: ${w.whileOff === 1 ? "the 1 person added who was never welcomed is" : `the ${w.whileOff} people added who were never welcomed are`} welcomed, with a link to set up their sign-in, once an Admin switches welcome emails on.`,
    w.welcomedBefore === 0 ? null : `${plural(w.welcomedBefore, "person added was", "people added were")} welcomed before: this owes them no new welcome.`,
  ].filter((x) => x !== null).join(" "),
  nothingSent: "Nothing was sent to QuickBooks.",
  money: "Each family's money is read from the books the next time a parent opens Home or Payments, when someone presses “Read every family now” on Balances, or at the daily read of every family's invoices, while the books are connected.",
} as const;

/** A refusal of the families' half: thrown, so its transaction keeps nothing. */
class Refused extends Error { constructor(readonly words: string) { super(words); } }
/** The unique indexes of a student's link: a student customer or record linked meanwhile, the last line. */
const STUDENT_UQ = new Set(["accounting_link_student_customer_uq", "accounting_link_student_uq"]);
const uniqueViolated = (e: unknown): string | null => {
  if (typeof e !== "object" || e === null) return null;
  const pg = e as { code?: unknown; constraint_name?: unknown; cause?: unknown };
  if (pg.code === "23505") return typeof pg.constraint_name === "string" ? pg.constraint_name : "";
  return uniqueViolated(pg.cause);
};

/** One guardian's end, for the answer and the tests: what importGuardian() answered, or that it wasn't tried. */
/** Why a guardian wasn't added: what importGuardian() answered; an unexpected error as one was added (`failed`); or not tried after a `busy` or a `failed`. */
type NotAdded = Exclude<ImportGuardianResult, { ok: true }>["reason"] | "failed" | "not_tried" | "not_tried_failed";
export type ImportGuardianEnd = { family: string; familyId: AppFamilyId; guardian: ProposedGuardian; result: ImportGuardianResult | { ok: false; reason: "failed" | "not_tried" | "not_tried_failed" } };
export type ImportDone = (LinkDone & { ok: false }) | { ok: true; message: string; pressId: string; familyIds: AppFamilyId[]; guardians: ImportGuardianEnd[] };

/**
 * Make these families. The arguments come from the page and are checked first: 1 to IMPORT_MAX distinct customer ids,
 * each digits (isQboId()), the count an integer equal to their number, the stamp a string; anything else is
 * IMPORT_COPY.notFromPage. Then one transaction: the roster lock exclusively with the page's tag (ROSTER_MOVED), the
 * screen's reads again (readLinkBasics(tx), `listed` or its words), the aims, the persons and the proposal worked out
 * again by the one rule (importProposalOf()), sealing to the stamp the review drew (importStampHolds()), and every ticked
 * customer one of the families shown; any difference refuses the whole press in one set of words, making nothing
 * (IMPORT_COPY.changed). Then, for each ticked family in the review's order, the narrowed import, unchanged
 * (importRecordsFromRoster(tx, { familyCustomerId, linkedBy })): the family and its students, each linked `confirmed`
 * by the staff member with the cache's version, a student customer with a record left alone; one
 * `accounting.family.from_customer` row each, as "Create a family from this" writes it, with `import`, the press's id;
 * and one `accounting.import.save` row targeting the press. The unique indexes are the last line, answered as a list
 * that changed. Then it commits.
 *
 * Then the guardians, each in its own transaction, in the review's order (importGuardian()); on the first `busy` the
 * rest aren't tried, and are said. An unexpected error in a guardian's transaction (a dropped connection, a statement
 * timeout) is caught and said as that guardian not added (`failed`), the rest not tried, so the answer still names every
 * family made and every guardian not added, and the action still revalidates: the families are committed by then. A guardian not added leaves its family made and linked, said, to be added on the
 * family's page. Nothing is queued or sent; no link is minted (the worker's welcome holds each set-up link when it
 * sends: sendOwedWelcomes(), src/lib/parents/welcome.ts).
 */
export async function saveImport(raw: { customerIds: unknown; count: unknown; stamp: unknown }, rosterTag: string, o: LinkOp, w: Waits = {}): Promise<ImportDone> {
  const { customerIds, count, stamp } = raw;
  if (!Array.isArray(customerIds) || customerIds.length < 1 || customerIds.length > IMPORT_MAX || !customerIds.every((id): id is string => typeof id === "string" && isQboId(id))
    || new Set(customerIds).size !== customerIds.length || typeof count !== "number" || !Number.isInteger(count) || count !== customerIds.length
    || typeof stamp !== "string" || typeof rosterTag !== "string") return no(IMPORT_COPY.notFromPage) as ImportDone;
  const ticked = new Set(customerIds);
  const pressId = randomUUID();
  let made: { f: ProposedFamily; familyId: AppFamilyId }[];
  let counts: { studentsMade: number; studentsLeftAlone: number };
  try {
    ({ made, counts } = await db.transaction(async (tx) => {
      if (!(await lockRosterAs(tx, rosterTag))) throw new Refused(ROSTER_MOVED);
      const b = await readLinkBasics(tx);
      if (b.state !== "listed") throw new Refused(NO_FAMILY_COPY[b.state]);
      const proposal = await importProposalOf(b, customerAims(b, await madeAfterGivingUp(tx)), tx);
      if (proposal === null || !importStampHolds(importKeys(proposal.families), stamp)) throw new Refused(IMPORT_COPY.changed);
      const families = proposal.families.filter((f) => ticked.has(f.customerId));
      if (families.length !== ticked.size) throw new Refused(IMPORT_COPY.changed);
      const realmId = b.realm!;
      const out: { f: ProposedFamily; familyId: AppFamilyId }[] = [];
      let studentsMade = 0, studentsLeftAlone = 0;
      for (const f of families) {
        const r = await importRecordsFromRoster(tx, { familyCustomerId: f.customerId, linkedBy: o.staffUserId });
        // The proposal and the import read the same cache under the same lock: anything else is a list that changed.
        const sameStudents = (a: readonly string[], x: readonly string[]) => [...a].sort().join() === [...x].sort().join();
        if (r.family === null || !sameStudents(r.students.made.map((s) => s.customerId), f.students.made.map((s) => s.qboId))
          || !sameStudents(r.students.leftAlone.map((s) => s.customerId), f.students.leftAlone.map((s) => s.qboId))) throw new Refused(IMPORT_COPY.changed);
        const [c] = await tx.select({ displayName: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, f.customerId));
        await writeAudit({ actor: o.actor, action: "accounting.family.from_customer", permission: o.permission, targetType: "family", targetId: String(r.family), ip: o.ip,
          after: { familyId: String(r.family), name: c?.displayName ?? f.name, customerQboId: f.customerId, realmId, import: pressId,
            studentsMade: r.students.made.map((s) => ({ studentId: String(s.id), customerQboId: s.customerId })),
            studentsLeftAlone: r.students.leftAlone.map((s) => ({ studentId: String(s.id), customerQboId: s.customerId })),
            appRecords: r.changes } }, tx);
        studentsMade += r.students.made.length;
        studentsLeftAlone += r.students.leftAlone.length;
        out.push({ f, familyId: r.family });
      }
      await writeAudit({ actor: o.actor, action: "accounting.import.save", permission: o.permission, ip: o.ip, targetType: "accounting_link", targetId: pressId,
        after: { pressId, realmId, families: out.length, studentsMade, studentsLeftAlone, guardiansProposed: out.reduce((n, m) => n + m.f.guardians.length, 0),
          familyIds: out.map((m) => String(m.familyId)) } }, tx);
      return { made: out, counts: { studentsMade, studentsLeftAlone } };
    }));
  } catch (e) {
    if (e instanceof Refused) return no(e.words) as ImportDone;
    const which = uniqueViolated(e);
    if (isSecondFamilyLink(e) || (which !== null && STUDENT_UQ.has(which))) return no(IMPORT_COPY.changed) as ImportDone;
    throw e;
  }

  // The guardians, each in its own transaction, in the review's order, after the families' commit.
  const guardianOp = { actor: o.actor, ip: o.ip, permission: "Roster.Family.ReadWrite" };
  const madeHere = new Set<string>();
  const ends: ImportGuardianEnd[] = [];
  let stopped: "not_tried" | "not_tried_failed" | null = null;
  for (const m of made) {
    for (const g of m.f.guardians) {
      if (stopped !== null) { ends.push({ family: m.f.name, familyId: m.familyId, guardian: g, result: { ok: false, reason: stopped } }); continue; }
      let r: ImportGuardianEnd["result"];
      try {
        r = await importGuardian(m.familyId, { name: g.name, email: g.email, person: g.person.kind === "new" ? "new" : g.person.id, parentCustomerId: g.link?.qboId ?? null,
          pressId, madeHere, linkedBy: o.staffUserId }, guardianOp, w);
      } catch (e) {
        // Audited, not logged (nothing here writes to the log): the guardian is said as not added, and added on the family's page.
        r = { ok: false, reason: "failed" };
        const error = e instanceof Error ? e.name.slice(0, 40) : "unknown";
        await writeAudit({ actor: o.actor, action: "accounting.import.guardian_failed", permission: o.permission, ip: o.ip, targetType: "family", targetId: String(m.familyId),
          after: { pressId, family: String(m.familyId), error } }).catch(() => undefined);
      }
      if (r.ok && r.person === "new") madeHere.add(r.parentId);
      if (!r.ok && r.reason === "busy") stopped = "not_tried";
      if (!r.ok && r.reason === "failed") stopped = "not_tried_failed";
      ends.push({ family: m.f.name, familyId: m.familyId, guardian: g, result: r });
    }
  }
  return { ok: true, pressId, familyIds: made.map((m) => m.familyId), guardians: ends,
    message: importedWords({ families: made.map((m) => m.f.name), ...counts, ends }) };
}

/**
 * What staff read after the press, each sentence true by the code: the families made and linked (named up to a
 * handful), the students made and left alone, the guardians added (new people and people reused), the Parent customers
 * linked and those that couldn't be now, each guardian not added with why and that they are added on the family's page,
 * whether welcomes go now or once an Admin switches them on (by where each person's welcome stands once added, never by
 * a read of the switch after), that nothing was sent, and when the money is read.
 */
export function importedWords(s: { families: string[]; studentsMade: number; studentsLeftAlone: number; ends: readonly ImportGuardianEnd[] }): string {
  const added = s.ends.flatMap((e) => (e.result.ok ? [e.result] : []));
  const parts = [IMPORT_COPY.families(s.families), IMPORT_COPY.students(s.studentsMade, s.studentsLeftAlone),
    IMPORT_COPY.guardians(added.length, added.filter((a) => a.person === "new").length, added.filter((a) => a.person === "existing").length)];
  const linked = IMPORT_COPY.linked(added.filter((a) => a.link === "linked").length, added.filter((a) => a.link === "not_linked").length);
  if (linked !== "") parts.push(linked);
  for (const e of s.ends) if (!e.result.ok) parts.push(IMPORT_COPY.notAdded(e.guardian.name, e.guardian.email, e.family, GUARDIAN_NOT_ADDED[e.result.reason]));
  if (added.length > 0) {
    // Each person once, as they stand after their last add (a person in two families is one welcome).
    const stands = new Map(added.map((a) => [a.parentId, a.welcome]));
    const count = (w: string) => [...stands.values()].filter((x) => x === w).length;
    parts.push(IMPORT_COPY.welcomes({ owed: count("owed"), welcomedBefore: count("welcomed_before"), whileOff: count("while_off") }));
  }
  parts.push(IMPORT_COPY.nothingSent, IMPORT_COPY.money);
  return parts.join(" ");
}
