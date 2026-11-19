// Privacy: the one module a parent's buy-out pages read through (v1 spec §11.5, §12 invariant 1). The family is the
// session's (ctx.familyId, the app's own family record), with its own active students (sessionFamily(), the volunteer
// pages' one definition of the session's family), and nothing else: the requirements are the current season's
// volunteer ones that ask something of that family or its own active students, and the buy-outs read are that family's
// own, by its records. What the browser sends back is the requirement id and a choice key made here from the family's
// own list of subjects ("family", or "s1", "s2" for its students in the order the family's pages list them, by name and
// then the app's id: never by a QuickBooks id), never an id; both are
// looked up again within the session's family. Of another family's buy-outs only this is read: whether one still
// stands for one of this family's own students (a student who moved here), so no choice is offered that could never be
// set up. Nothing of it is shown. What a buy-out bills stays QuickBooks', and this is the one place a parent's buy-out
// reads it: the family's own linked customer (customerOfFamily()), or the student's own (customerOfStudent()), in the
// records' company, and a student only while the roster cache holds their customer active and directly under the
// family's (billing follows QuickBooks' tree until QuickBooks takes a move: open question 14). With no link, or while
// the membership shape doesn't hold (shapeHolds()), there is no offer. It imports no staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db/client";
import { buyout, qboCustomer, requirement, season, seasonStep, type BuyoutState } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { isUuid } from "@/lib/seasons/ids";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { customerOfFamily, linksOf } from "@/lib/families/links";
import { sessionFamily, type SessionFamily } from "@/lib/families/session-family";
import { pairKey } from "@/lib/seasons/kinds";
import { isCovered, type Requirement, type SubjectId, type SubjectsAsked } from "@/lib/seasons/progress";
import { loadFacts, toRequirement } from "@/lib/seasons/recorded";
import { loadCovers } from "@/lib/seasons/season-rows";
import { confirmedAmounts } from "@/lib/volunteer/credit";
import { getRosterSource } from "@/lib/roster/source";
import { shapeHolds } from "@/lib/roster/shape";
import { guardianMay, LIVE_STATES, quoteBuyout, buyoutOffered, type Quote } from "./rules";
import { buyoutFacts } from "./standing";

/** What a parent's page is given about one requirement and one subject: words, amounts and what they may do. No id but the requirement's. */
export type MyBuyout = {
  requirementId: string; title: string; unit: "shifts" | "hours";
  /** The choice key the page sends back: "family", or "s1", "s2" for the family's students. */
  key: string;
  /** "Your family", or the student's name. */
  who: string;
  /** How the requirement stands, in the words the season pages use ("1 of 2 shifts done", "Buy-out invoiced", "Paid instead"). */
  standing: string; met: boolean;
  /** What a buy-out would cost now, worked out on the server; and its stamp, which the confirm sends back. */
  quote: Quote; stamp: string | null;
  /** Which family, requirement and subject the page shows (subjectStamp()), which the confirm and the switch-back send back. */
  subjectStamp: string;
  /** The buy-out that stands, if one does: its price as it was fixed. */
  buyout: { state: BuyoutState; units: number; unitCents: number; amountCents: number; invoicePaid: boolean;
    /** The club has something to look at about its invoice (the daily check or a void flagged it): the page says so, and offers nothing. */
    clubLooking: boolean } | null;
  may: "choose" | "switch_back" | "wait" | "nothing";
  /** A buy-out the club couldn't set up, the last time one was tried: the page says so calmly. */
  refusedBefore: boolean;
};
/**
 * What the server alone keeps of a choice, for the confirm: the session's app family, the app's student a per-student
 * requirement's choice is for (null for the family's own), and who the invoice is billed to. Never sent to a page.
 */
export type BuyoutTarget = { view: MyBuyout; familyId: AppFamilyId; studentId: AppStudentId | null; customerQboId: string; itemQboId: string; realmId: string; requirement: Requirement };

const KEY = /^(family|s[1-9]\d{0,2})$/;
export const isChoiceKey = (v: unknown): v is string => typeof v === "string" && KEY.test(v);

/**
 * The quote's stamp: which family, requirement, subject, customer billed, item and price the guardian was shown, sealed
 * with the server's key so nothing in it can be read or made in the browser. The confirm works the quote out again and
 * refuses when it differs. It seals the app's own ids of the session's family and of the subject (the family itself,
 * or the student), so it never bills the wrong student; a stamp made before the session carried the app's family (it
 * sealed QuickBooks ids) fails it and is answered with the price-changed words. Which subject the page showed is the
 * subject stamp's to say (subjectStamp()), and the confirm checks that first: a key that has come to name another
 * student is answered with the reload words, so the quote's stamp speaks only for the price.
 */
export const quoteStamp = (familyId: AppFamilyId, requirementId: string, subject: SubjectId, customerQboId: string, itemQboId: string, q: Quote): string | null =>
  q.ok ? createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`buyout-quote-app:${String(familyId)}|${requirementId}|${String(subject)}|${customerQboId}|${itemQboId}|${q.unitCents}|${q.units}|${q.amountCents}`).digest("base64url").slice(0, 22) : null;

/**
 * The subject's stamp, which the confirm and the switch-back both send back: which family, requirement and subject
 * (the family itself, or the student, by the app's ids) the page showed, sealed with the server's key. A key that has
 * come to name another student since the page was drawn (one joined, left or was renamed, and the order moved) fails
 * it, and nothing is set up or switched back, so a stale page never bills or voids for a sibling. It holds no price.
 */
export const subjectStamp = (familyId: AppFamilyId, requirementId: string, subject: SubjectId): string =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`buyout-subject-app:${String(familyId)}|${requirementId}|${String(subject)}`).digest("base64url").slice(0, 22);

/** One of the family's subjects: its key, its own customer (who would be billed), its app record, and who it is in words. */
type Subject = { key: string; qboId: string; record: SubjectId; studentId: AppStudentId | null; who: string };

/**
 * Who would be billed for each of the family's subjects, from QuickBooks' side and nowhere else: the family's own
 * linked customer, and each student's own linked customer that the roster cache holds active and directly under it.
 * Null with no family link, and while the membership shape can't say whose customers are the family's (none, or one
 * naming a customer type QuickBooks no longer has: shapeHolds(), money's rule too): no offer at all. A student missing
 * from `students` is not billable.
 */
async function billedCustomers(records: SessionFamily): Promise<{ family: string; students: Map<string, string> } | null> {
  const [family, holds] = await Promise.all([customerOfFamily(records.familyId), shapeHolds()]);
  if (family === null || !holds) return null;
  const students = new Map<string, string>();
  if (records.students.length === 0) return { family, students };
  const links = await linksOf({ families: [], students: records.students.map((s) => s.id) });
  const customers = [...links.customerOfStudent.values()];
  const under = customers.length === 0 ? [] : await db.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
    .where(and(eq(qboCustomer.parentQboId, family), eq(qboCustomer.active, true), inArray(qboCustomer.qboId, customers)));
  const ok = new Set(under.map((u) => u.qboId));
  for (const s of records.students) {
    const customer = links.customerOfStudent.get(s.id);
    if (customer !== undefined && ok.has(customer)) students.set(String(s.id), customer);
  }
  return { family, students };
}

/**
 * Who in the family a requirement asks, each with its key: the family once, or each of its students it covers. A
 * student's key is its place among the family's active students as sessionFamily() lists them (by name, then the app's
 * id); one with no customer to bill is asked nothing, and keeps its place. A key that comes to name another student
 * (one joined or left the family, or a rename moved the order) fails the subject's stamp (subjectStamp()), which the
 * confirm and the switch-back check first, and the quote's, which both seal the student's own record.
 */
function subjectsOf(r: Requirement, records: SessionFamily, billed: { family: string; students: Map<string, string> }): Subject[] {
  if (r.appliesTo === "family") {
    return isCovered(r, records.familyId) ? [{ key: "family", qboId: billed.family, record: records.familyId, studentId: null, who: "Your family" }] : [];
  }
  return records.students.flatMap((s, i) => {
    const customer = billed.students.get(String(s.id));
    return customer !== undefined && isCovered(r, s.id) ? [{ key: `s${i + 1}`, qboId: customer, record: s.id, studentId: s.id, who: s.name }] : [];
  });
}

/** Whether a buy-out is for this subject: the family's own (no student), or this student's. */
const isFor = (b: { studentId: AppStudentId | null }, s: Subject) => b.studentId === s.studentId;

/**
 * Every buy-out choice the current season gives the session's family: each volunteer requirement that offers a buy-out,
 * or has one standing for the family, for the family or for each of its students it asks. `only` narrows it to one
 * requirement. In the season's order. None while the family has no active record.
 */
async function loadTargets(ctx: Pick<ParentCtx, "familyId" | "parentId">, only?: string): Promise<BuyoutTarget[]> {
  const rows = await db.select({ r: requirement }).from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(eq(season.isCurrent, true), eq(requirement.kind, "volunteer"), only ? eq(requirement.id, only) : undefined))
    .orderBy(asc(seasonStep.position), asc(requirement.position), asc(requirement.createdAt));
  if (rows.length === 0) return [];
  // The family and its students as the app's records, by the one definition of the session's family the volunteer
  // pages use (sessionFamily(): its active record, and its own active students); nothing of a family whose record is
  // inactive is asked about, and nothing is offered to a family with no customer to bill.
  const records = await sessionFamily(ctx.familyId);
  if (records === null) return [];
  const billed = await billedCustomers(records);
  if (billed === null) return [];
  const own = records.students.map((s) => s.id);
  const asked: SubjectsAsked = { families: [records.familyId], students: own };
  const covers = await loadCovers(rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id), asked);
  const requirements = rows.map((x) => ({ row: x.r, r: toRequirement(x.r, covers.get(x.r.id) ?? []) }));
  const ids = requirements.map((x) => x.r.id);
  // The family's own buy-outs only: the session's family record is the only family asked about.
  const mine = await db.select().from(buyout).where(and(eq(buyout.familyId, records.familyId), inArray(buyout.requirementId, ids)));
  // A live buy-out another family chose for one of this family's own students (moved here in QuickBooks): it holds the
  // one live place for that requirement and student (buyout_student_live_uq), so a choice here could never be set up.
  // Only that it stands is read.
  const elsewhere = own.length === 0 ? [] : await db.select({ requirementId: buyout.requirementId, studentId: buyout.studentId }).from(buyout)
    .where(and(inArray(buyout.requirementId, ids), inArray(buyout.studentId, own), ne(buyout.familyId, records.familyId), inArray(buyout.state, [...LIVE_STATES])));
  const [facts, confirmed, standing, source] = await Promise.all([
    buyoutFacts(ids, asked, pairKey), confirmedAmounts(requirements.map((x) => x.r), asked, pairKey),
    loadFacts(requirements.map((x) => x.r), asked, { amounts: "fresh", parentId: ctx.parentId }), getRosterSource(),
  ]);
  const out: BuyoutTarget[] = [];
  for (const { row, r } of requirements) {
    const terms = { kind: r.kind, amount: r.amount, amountUnit: r.amountUnit, buyoutUnitCents: row.buyoutUnitCents, itemQboId: row.itemQboId };
    for (const s of subjectsOf(r, records, billed)) {
      const fact = facts.get(pairKey(r.id, s.record)) ?? null;
      const live = fact ? mine.find((b) => b.requirementId === r.id && isFor(b, s) && LIVE_STATES.includes(b.state)) ?? null : null;
      if (!buyoutOffered(terms) && !live) continue;
      if (!live && elsewhere.some((e) => e.requirementId === r.id && isFor(e, s))) continue;
      // A requirement staff waived needs nothing (v1 spec §10.2): there is nothing to buy, as when credit has met it.
      const shown = !live && standing.facts.waived(r.id, s.record) ? { met: true, words: "Waived" } : standing.facts.standing(r, s.record);
      const quote = shown.met ? { ok: false as const, why: "met" as const } : quoteBuyout(terms, confirmed.get(pairKey(r.id, s.record)) ?? 0);
      const last = mine.filter((b) => b.requirementId === r.id && isFor(b, s)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      out.push({
        familyId: records.familyId, studentId: s.studentId, customerQboId: s.qboId, itemQboId: row.itemQboId ?? "", realmId: source ?? "", requirement: r,
        view: {
          requirementId: r.id, title: r.title, unit: r.amountUnit ?? "shifts", key: s.key, who: s.who, standing: shown.words, met: shown.met,
          quote, stamp: row.itemQboId ? quoteStamp(records.familyId, r.id, s.record, s.qboId, row.itemQboId, quote) : null,
          subjectStamp: subjectStamp(records.familyId, r.id, s.record),
          buyout: live && fact ? { state: live.state, units: live.units, unitCents: live.unitCents, amountCents: live.amountCents, invoicePaid: fact.invoicePaid,
            clubLooking: live.flag !== null } : null,
          may: live?.flag ? "nothing" : guardianMay(fact, quote), refusedBefore: !live && last?.state === "refused",
        },
      });
    }
  }
  return out;
}

/** The Volunteer page's list: every buy-out choice the season gives the family, in words and amounts. */
export async function loadMyBuyouts(ctx: Pick<ParentCtx, "familyId" | "parentId">): Promise<MyBuyout[]> {
  return (await loadTargets(ctx)).map((t) => t.view);
}

/**
 * One choice, for its page and its actions: the requirement id and the key come from the browser, and are looked up
 * within the session's family's own list. Null for anything that isn't there (the page answers 404).
 */
export async function findMyBuyout(ctx: Pick<ParentCtx, "familyId" | "parentId">, requirementId: unknown, key: unknown): Promise<BuyoutTarget | null> {
  if (!isUuid(requirementId) || !isChoiceKey(key)) return null;
  return (await loadTargets(ctx, requirementId)).find((t) => t.view.key === key) ?? null;
}
