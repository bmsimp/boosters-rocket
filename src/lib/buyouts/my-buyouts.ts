// Privacy: the one module a parent's buy-out pages read through (v1 spec §11.5, §12 invariant 1). The family is the
// session's (ctx.familyQboId) and nothing else: the requirements are the current season's volunteer ones that ask
// something of that family or its own active students, and the buy-outs read are that family's own. What the browser
// sends back is the requirement id and a choice key made here from the family's own list of subjects ("family", or
// "s1", "s2" for its students in id order), never a QuickBooks id; both are looked up again within the session's family.
// Of another family's buy-outs only this is read: whether one still stands for one of this family's own students (a
// student who moved here in QuickBooks), so no choice is offered that could never be set up. Nothing of it is shown.
// It imports no staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db/client";
import { buyout, qboCustomer, requirement, season, seasonStep, type BuyoutState } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { MyFamily } from "@/lib/parents/my-family";
import { isUuid } from "@/lib/seasons/ids";
// The season by customer: a boundary of stage 2 of the app-owned families spec (AGENTS.md, Seasons), until buy-outs
// move to the app's ids.
import { loadCustomerCovers } from "@/lib/seasons/by-customer";
import { customerPairKey, isCustomerCovered, toCustomerRequirement, type CustomerRequirement } from "@/lib/seasons/customer-keys";
import { loadCustomerFacts } from "@/lib/seasons/recorded";
import { confirmedAmounts } from "@/lib/volunteer/credit";
import { getRosterSource } from "@/lib/roster/source";
import { guardianMay, LIVE_STATES, quoteBuyout, buyoutOffered, type Quote } from "./rules";
import { buyoutFacts } from "./standing";

/** What a parent's page is given about one requirement and one subject: words, amounts and what they may do. No QuickBooks id. */
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
  /** The buy-out that stands, if one does: its price as it was fixed. */
  buyout: { state: BuyoutState; units: number; unitCents: number; amountCents: number; invoicePaid: boolean;
    /** The club has something to look at about its invoice (the daily check or a void flagged it): the page says so, and offers nothing. */
    clubLooking: boolean } | null;
  may: "choose" | "switch_back" | "wait" | "nothing";
  /** A buy-out the club couldn't set up, the last time one was tried: the page says so calmly. */
  refusedBefore: boolean;
};
/** What the server alone keeps of a choice, for the confirm: the subject and who the invoice is billed to. Never sent to a page. */
export type BuyoutTarget = { view: MyBuyout; subjectQboId: string; customerQboId: string; itemQboId: string; realmId: string; requirement: CustomerRequirement };

const KEY = /^(family|s[1-9]\d{0,2})$/;
export const isChoiceKey = (v: unknown): v is string => typeof v === "string" && KEY.test(v);

/**
 * The quote's stamp: which requirement, subject, item and price the guardian was shown, sealed with the server's key so
 * nothing in it can be read or made in the browser. The confirm works the quote out again and refuses when it differs.
 */
export const quoteStamp = (familyQboId: string, requirementId: string, subjectQboId: string, itemQboId: string, q: Quote): string | null =>
  q.ok ? createHmac("sha256", env.BETTER_AUTH_SECRET).update(`buyout-quote:${familyQboId}|${requirementId}|${subjectQboId}|${itemQboId}|${q.unitCents}|${q.units}|${q.amountCents}`).digest("base64url").slice(0, 22) : null;

type Subject = { key: string; qboId: string; who: string };

/** The family's active students as loadMyFamily() gave them, kept only where the roster cache holds them directly under the session's family, in id order. */
async function myStudents(ctx: Pick<ParentCtx, "familyQboId">, family: Pick<MyFamily, "students">): Promise<{ qboId: string; name: string }[]> {
  const asked = (family.students ?? []).map((s) => s.qboId);
  if (asked.length === 0) return [];
  const under = await db.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
    .where(and(eq(qboCustomer.parentQboId, ctx.familyQboId), eq(qboCustomer.active, true), inArray(qboCustomer.qboId, asked)));
  const ok = new Set(under.map((u) => u.qboId));
  return (family.students ?? []).filter((s) => ok.has(s.qboId)).sort((a, b) => (a.qboId < b.qboId ? -1 : a.qboId > b.qboId ? 1 : 0));
}

/** Who in the family a requirement asks, each with its key: the family once, or each of its students it covers. */
function subjectsOf(r: CustomerRequirement, familyQboId: string, students: { qboId: string; name: string }[]): Subject[] {
  if (r.appliesTo === "family") return isCustomerCovered(r, familyQboId) ? [{ key: "family", qboId: familyQboId, who: "Your family" }] : [];
  return students.flatMap((s, i) => (isCustomerCovered(r, s.qboId) ? [{ key: `s${i + 1}`, qboId: s.qboId, who: s.name }] : []));
}

/**
 * Every buy-out choice the current season gives the session's family: each volunteer requirement that offers a buy-out,
 * or has one standing for the family, for the family or for each of its students it asks. `only` narrows it to one
 * requirement. In the season's order.
 */
async function loadTargets(ctx: Pick<ParentCtx, "familyQboId" | "parentId">, family: Pick<MyFamily, "students">, only?: string): Promise<BuyoutTarget[]> {
  const rows = await db.select({ r: requirement }).from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(eq(season.isCurrent, true), eq(requirement.kind, "volunteer"), only ? eq(requirement.id, only) : undefined))
    .orderBy(asc(seasonStep.position), asc(requirement.position), asc(requirement.createdAt));
  if (rows.length === 0) return [];
  const students = await myStudents(ctx, family);
  const subjectIds = [ctx.familyQboId, ...students.map((s) => s.qboId)];
  const covers = await loadCustomerCovers(rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id), subjectIds);
  const requirements = rows.map((x) => ({ row: x.r, r: toCustomerRequirement(x.r, covers.get(x.r.id) ?? []) }));
  const ids = requirements.map((x) => x.r.id);
  // The family's own buy-outs only: the session's family id is the only one asked about.
  const mine = await db.select().from(buyout).where(and(eq(buyout.familyQboId, ctx.familyQboId), inArray(buyout.requirementId, ids)));
  // A live buy-out another family chose for one of this family's own students (moved here in QuickBooks): it holds the
  // one live place for that requirement and student (buyout_live_uq), so a choice here could never be set up.
  const elsewhere = students.length === 0 ? [] : await db.select({ requirementId: buyout.requirementId, subjectQboId: buyout.subjectQboId }).from(buyout)
    .where(and(inArray(buyout.requirementId, ids), inArray(buyout.subjectQboId, students.map((s) => s.qboId)), ne(buyout.familyQboId, ctx.familyQboId), inArray(buyout.state, [...LIVE_STATES])));
  const [facts, confirmed, standing, source] = await Promise.all([
    buyoutFacts(ids, subjectIds), confirmedAmounts(requirements.map((x) => x.r), subjectIds, customerPairKey),
    loadCustomerFacts(requirements.map((x) => x.r), subjectIds, { amounts: "fresh", parentId: ctx.parentId }), getRosterSource(),
  ]);
  const out: BuyoutTarget[] = [];
  for (const { row, r } of requirements) {
    const terms = { kind: r.kind, amount: r.amount, amountUnit: r.amountUnit, buyoutUnitCents: row.buyoutUnitCents, itemQboId: row.itemQboId };
    for (const s of subjectsOf(r, ctx.familyQboId, students)) {
      const key = customerPairKey(r.id, s.qboId);
      const fact = facts.get(key) ?? null;
      const live = fact ? mine.find((b) => b.requirementId === r.id && b.subjectQboId === s.qboId && LIVE_STATES.includes(b.state)) ?? null : null;
      if (!buyoutOffered(terms) && !live) continue;
      if (!live && elsewhere.some((e) => e.requirementId === r.id && e.subjectQboId === s.qboId)) continue;
      // A requirement staff waived needs nothing (v1 spec §10.2): there is nothing to buy, as when credit has met it.
      const shown = !live && standing.facts.waived(r.id, s.qboId) ? { met: true, words: "Waived" } : standing.facts.standing(r, s.qboId);
      const quote = shown.met ? { ok: false as const, why: "met" as const } : quoteBuyout(terms, confirmed.get(key) ?? 0);
      const last = mine.filter((b) => b.requirementId === r.id && b.subjectQboId === s.qboId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      out.push({
        subjectQboId: s.qboId, customerQboId: s.qboId, itemQboId: row.itemQboId ?? "", realmId: source ?? "", requirement: r,
        view: {
          requirementId: r.id, title: r.title, unit: r.amountUnit ?? "shifts", key: s.key, who: s.who, standing: shown.words, met: shown.met,
          quote, stamp: row.itemQboId ? quoteStamp(ctx.familyQboId, r.id, s.qboId, row.itemQboId, quote) : null,
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
export async function loadMyBuyouts(ctx: Pick<ParentCtx, "familyQboId" | "parentId">, family: Pick<MyFamily, "students">): Promise<MyBuyout[]> {
  return (await loadTargets(ctx, family)).map((t) => t.view);
}

/**
 * One choice, for its page and its actions: the requirement id and the key come from the browser, and are looked up
 * within the session's family's own list. Null for anything that isn't there (the page answers 404).
 */
export async function findMyBuyout(ctx: Pick<ParentCtx, "familyQboId" | "parentId">, family: Pick<MyFamily, "students"> | null, requirementId: unknown, key: unknown): Promise<BuyoutTarget | null> {
  if (!family || !isUuid(requirementId) || !isChoiceKey(key)) return null;
  return (await loadTargets(ctx, family, requirementId)).find((t) => t.view.key === key) ?? null;
}
