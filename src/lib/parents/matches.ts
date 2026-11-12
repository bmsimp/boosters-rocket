import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMatch, heldAddress, parent } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import type { StaffOp } from "./people";
import { loadDecision, reconcileAccess } from "./reconcile";
import { getPreviousCompany, putPreviousCompany, type PreviousCompany } from "./company-change";

export type NewFamily = { qboId: string; name: string; emails: string[] };
export type MatchSuggestion = {
  old: { qboId: string; name: string; emails: string[] };
  suggested: { qboId: string; name: string } | null; nameMatches: boolean; addressesMatched: number; strong: boolean;
  decision: "matched" | "rejected" | null; matchedTo: { qboId: string; name: string } | null;
};
type Result = { ok: true } | { ok: false; errors: string[] };
const CARRIED_NOTE = "Carried over from the previous QuickBooks company by an accepted match.";

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * For each family of the previous company, the family of the connected one it most likely is (spec §6). Pure. A
 * suggestion needs a matching name or a matching address: an ID alone means nothing across companies. More matching
 * addresses beat a matching name; ties go to the lower ID. A new family is suggested for at most one old family.
 */
export function suggestMatches(prev: PreviousCompany, families: NewFamily[]): MatchSuggestion[] {
  const taken = new Set(prev.families.map((f) => f.matchedTo).filter((id): id is string => id !== null));
  const byId = new Map(families.map((f) => [f.qboId, f]));
  return prev.families.map((f) => {
    const emails = [...new Set(f.people.map((p) => p.email))].sort();
    const old = { qboId: f.qboId, name: f.name, emails };
    const matched = f.matchedTo ? { qboId: f.matchedTo, name: byId.get(f.matchedTo)?.name ?? `Family ${f.matchedTo}` } : null;
    if (f.decision === "matched") return { old, suggested: null, nameMatches: false, addressesMatched: 0, strong: false, decision: f.decision, matchedTo: matched };
    const scored = families.filter((n) => !taken.has(n.qboId)).map((n) => ({ n, name: sameName(n.name, f.name), hits: emails.filter((e) => n.emails.includes(e)).length }))
      .filter((s) => s.name || s.hits > 0)
      .sort((a, b) => b.hits - a.hits || Number(b.name) - Number(a.name) || numeric(a.n.qboId, b.n.qboId));
    const best = scored[0];
    if (!best) return { old, suggested: null, nameMatches: false, addressesMatched: 0, strong: false, decision: f.decision, matchedTo: null };
    taken.add(best.n.qboId);
    return { old, suggested: { qboId: best.n.qboId, name: best.n.name }, nameMatches: best.name, addressesMatched: best.hits,
      strong: best.name && emails.length > 0 && best.hits === emails.length, decision: f.decision, matchedTo: null };
  });
}

/**
 * The snapshot and the connected company's families (with every address the rules saw under each, granted or held),
 * or null when there is nothing to review: no snapshot, a snapshot made for a company that isn't the connected one, a
 * cache read from another company, or no roster the rules can decide from.
 */
async function load(tx?: Tx): Promise<{ prev: PreviousCompany; families: NewFamily[] } | null> {
  const prev = await getPreviousCompany(tx);
  if (!prev) return null;
  if ((await getConnection(tx))?.realmId !== prev.newRealmId || (await getRosterSource(tx)) !== prev.newRealmId) return null;
  const loaded = await loadDecision(tx);
  if (!loaded) return null;
  const emails = new Map<string, Set<string>>();
  const add = (familyQboId: string, email: string | null) => { if (email) emails.set(familyQboId, (emails.get(familyQboId) ?? new Set()).add(email)); };
  for (const g of loaded.decision.grants) add(g.familyQboId, g.email);
  for (const d of loaded.decision.denials) if (d.reason === "held") add(d.familyQboId, d.email);
  const all = loaded.roster.kind === "flat" ? loaded.roster.members : loaded.roster.families.map((f) => f.customer);
  return { prev, families: all.filter((c) => c.active).map((c) => ({ qboId: c.qboId, name: c.displayName, emails: [...(emails.get(c.qboId) ?? [])].sort() })) };
}

/**
 * What the match review page shows, and nothing else of the snapshot: no realm ID, person ID or welcome date.
 * Null when there is nothing to review.
 */
export async function matchReview(): Promise<{ suggestions: MatchSuggestion[]; families: { qboId: string; name: string }[] } | null> {
  const got = await load();
  if (!got) return null;
  return { suggestions: suggestMatches(got.prev, got.families),
    families: got.families.map((f) => ({ qboId: f.qboId, name: f.name })).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || numeric(a.qboId, b.qboId)) };
}

/**
 * Accepts (`newFamilyQboId` set) or rejects (null) a match. Both IDs come from a browser: anything that isn't a family
 * in the snapshot or in the connected company's list is refused. Accepting records it for good, carries over the
 * approvals that involved the old family and the welcome history of its people, then runs the reconcile. It never
 * grants access by itself: that still comes only from the connected company's roster, and only while sign-ins are on.
 */
export async function decideMatch(oldFamilyQboId: string, newFamilyQboId: string | null, o: StaffOp): Promise<Result> {
  const notInList: Result = { ok: false, errors: ["That family isn't in the previous company's list."] };
  if (typeof oldFamilyQboId !== "string") return notInList;
  if (newFamilyQboId !== null && typeof newFamilyQboId !== "string") return { ok: false, errors: ["Choose a family from the list."] };
  return db.transaction(async (tx): Promise<Result> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const got = await load(tx);
    const old = got?.prev.families.find((f) => f.qboId === oldFamilyQboId);
    if (!got || !old) return notInList;
    const { prev, families } = got;
    if (old.decision === "matched") return { ok: false, errors: ["That family is already matched."] };
    const audit = (after: Record<string, unknown>) => writeAudit({ actor: o.actor, action: "parent.match.decided", permission: o.permission,
      targetType: "family_match", targetId: oldFamilyQboId, ip: o.ip, before: { decision: old.decision }, after }, tx);
    const save = (decision: "matched" | "rejected", matchedTo: string | null) =>
      putPreviousCompany(tx, { ...prev, families: prev.families.map((f) => (f.qboId === oldFamilyQboId ? { ...f, decision, matchedTo } : f)) });
    if (newFamilyQboId === null) {
      await save("rejected", null);
      await audit({ decision: "rejected", oldFamilyQboId });
      return { ok: true };
    }
    if (!families.some((f) => f.qboId === newFamilyQboId)) return { ok: false, errors: ["Choose a family from the list."] };
    if (prev.families.some((f) => f.matchedTo === newFamilyQboId)) return { ok: false, errors: ["That family is already matched to another one."] };
    // One match per old family for good; a club that went back to that company and away again decides it afresh.
    const now = new Date();
    await tx.insert(familyMatch).values({ oldRealmId: prev.realmId, oldFamilyQboId, newRealmId: prev.newRealmId, newFamilyQboId, decidedBy: o.actor.id, decidedAt: now })
      .onConflictDoUpdate({ target: [familyMatch.oldRealmId, familyMatch.oldFamilyQboId], set: { newRealmId: prev.newRealmId, newFamilyQboId, decidedBy: o.actor.id, decidedAt: now } });
    const carried = prev.approvals.filter((x) => x.familyQboIds.includes(oldFamilyQboId));
    for (const a of carried) {
      await tx.insert(heldAddress).values({ email: a.email }).onConflictDoNothing();
      const [row] = await tx.select().from(heldAddress).where(eq(heldAddress.email, a.email)).for("update");
      if (row!.approvedFamilyQboIds.includes(newFamilyQboId)) continue;
      const approved = [...new Set([...row!.approvedFamilyQboIds, newFamilyQboId])].sort(numeric);
      await tx.update(heldAddress).set({ approvedFamilyQboIds: approved, decidedBy: o.actor.id, decidedAt: now, note: row!.note ?? CARRIED_NOTE, updatedAt: now })
        .where(eq(heldAddress.email, a.email));
    }
    let welcomesRestored = 0;
    for (const p of old.people.filter((x) => x.welcomedAt)) {
      const done = await tx.update(parent).set({ welcomedAt: new Date(p.welcomedAt!), welcomeOwed: false, updatedAt: new Date() })
        .where(and(eq(parent.id, p.parentId), isNull(parent.welcomedAt))).returning({ id: parent.id });
      welcomesRestored += done.length;
    }
    await save("matched", newFamilyQboId);
    await audit({ decision: "matched", oldFamilyQboId, newFamilyQboId, approvalsCarried: carried.length, welcomesRestored });
    await reconcileAccess(tx, { cause: "match" });
    return { ok: true };
  });
}

/** **Accept all strong matches**: every suggestion whose name and every address match (spec §6). */
export async function acceptStrongMatches(o: StaffOp): Promise<{ accepted: number }> {
  const review = await matchReview();
  let accepted = 0;
  for (const s of review?.suggestions ?? []) {
    if (s.strong && s.decision === null && s.suggested && (await decideMatch(s.old.qboId, s.suggested.qboId, o)).ok) accepted++;
  }
  return { accepted };
}
