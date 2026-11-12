// Privacy: `listPeople`, `getPerson`, `heldReview` and `familySignins` with `detailed: true` return other families' names
// or a block reason. Use them only on pages behind `Parents.ReadWrite`, never behind `Roster.Read`.
import { and, eq, inArray, max } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, qboCustomer, staffUser, type DisabledReason, type GuardianStatus } from "@/lib/db/schema";
import { familyLabel } from "@/app/components/family-label";
import type { HeldAddress } from "./access-rules";
import { loadDecision } from "./reconcile";

export type AccessKind = "can" | "cannot" | "held" | "blocked";
export type FamilySignin = { parentId: string | null; name: string; email: string | null; kind: AccessKind; words: string };
export type PersonFamily = { familyQboId: string; familyName: string; kind: AccessKind; words: string };
export type PersonRow = { parentId: string; name: string; email: string; blocked: boolean; families: PersonFamily[]; lastSigninAt: string | null; welcomedAt: string | null };
export type PersonDetail = PersonRow & { blockedReason: string | null; blockedAt: string | null; welcomeOwed: boolean };
export type DecidedHold = { email: string; approved: string[]; rejected: string[]; note: string | null; decidedAt: string | null; decidedBy: string | null };

const WHY: Record<DisabledReason, string> = {
  inactive: "inactive in QuickBooks", family_inactive: "the family is inactive in QuickBooks", no_email: "no email address in QuickBooks",
  no_active_students: "the family has no active students", not_in_quickbooks: "not listed under this family in QuickBooks",
  address_changed: "the email address changed in QuickBooks", company_changed: "a different QuickBooks company was connected",
  removed: "removed by staff", held: "",
};
const list = (names: readonly string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!);

/** One person's standing in one family, in plain words (spec §4 The roster). `otherFamilies` is given only to staff who may see it. */
export function accessWords(o: { status: GuardianStatus; reason: DisabledReason | null; blocked: boolean; otherFamilies?: readonly string[] | null }): { kind: AccessKind; words: string } {
  if (o.status === "disabled" && o.reason === "held") {
    return { kind: "held", words: `Held: this address is also under ${o.otherFamilies?.length ? list(o.otherFamilies) : "another family"}` };
  }
  if (o.status === "disabled") return { kind: "cannot", words: o.reason ? `Can't sign in: ${WHY[o.reason]}` : "Can't sign in" };
  if (o.blocked) return { kind: "blocked", words: "Blocked" };
  return { kind: "can", words: o.status === "invited" ? "Can sign in (hasn't yet)" : "Can sign in" };
}

/** Family names from the roster cache, for showing a family to staff and to its own parents. */
export async function familyNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(inArray(qboCustomer.qboId, unique)) : [];
  const found = new Map(rows.map((r) => [r.qboId, r.name]));
  return new Map(unique.map((id) => [id, found.get(id) ?? familyLabel(id)]));
}

const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

async function people(where?: ReturnType<typeof eq>): Promise<PersonDetail[]> {
  const persons = await db.select().from(parent).where(where).orderBy(parent.name, parent.email);
  if (!persons.length) return [];
  const ids = persons.map((p) => p.id);
  const [links, signins, held] = await Promise.all([
    db.select().from(guardian).where(inArray(guardian.parentId, ids)),
    db.select({ id: auditLog.targetId, at: max(auditLog.at) }).from(auditLog)
      .where(and(eq(auditLog.action, "signin"), eq(auditLog.door, "parent"), inArray(auditLog.targetId, ids))).groupBy(auditLog.targetId),
    loadDecision().then((l) => l?.decision.held ?? []),
  ]);
  const names = await familyNames(links.map((l) => l.familyQboId));
  const last = new Map(signins.map((s) => [s.id, s.at]));
  return persons.map((p) => ({
    parentId: p.id, name: p.name, email: p.email, blocked: p.blocked,
    families: links.filter((l) => l.parentId === p.id).sort((a, b) => numeric(a.familyQboId, b.familyQboId)).map((l) => ({
      familyQboId: l.familyQboId, familyName: names.get(l.familyQboId)!,
      ...accessWords({ status: l.status, reason: l.disabledReason, blocked: p.blocked,
        otherFamilies: held.find((h) => h.email === p.email)?.families.filter((f) => f.qboId !== l.familyQboId).map((f) => f.name) ?? null }) })),
    lastSigninAt: last.get(p.id)?.toISOString() ?? null, welcomedAt: p.welcomedAt?.toISOString() ?? null,
    blockedReason: p.blockedReason, blockedAt: p.blockedAt?.toISOString() ?? null, welcomeOwed: p.welcomeOwed,
  }));
}

/** Everyone the portal knows, for staff with `Parents.ReadWrite` (spec §4 Parents). `q` matches part of a name or address. */
export async function listPeople(q?: string): Promise<PersonRow[]> {
  const needle = (q ?? "").trim().toLowerCase().slice(0, 100);
  return (await people()).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.includes(needle))
    .map((p): PersonRow => ({ parentId: p.parentId, name: p.name, email: p.email, blocked: p.blocked, families: p.families, lastSigninAt: p.lastSigninAt, welcomedAt: p.welcomedAt }));
}

export async function getPerson(parentId: string): Promise<PersonDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(parentId)) return null;
  return (await people(eq(parent.id, parentId)))[0] ?? null;
}

/**
 * The **Portal sign-ins** box on a family's roster page: the people linked to the family, and (once sign-ins are on)
 * the QuickBooks candidates who have no link because the rules refused them. `detailed` is for staff with
 * `Parents.ReadWrite`: only they are told which other family a held address is under (spec §4).
 */
export async function familySignins(familyQboId: string, o: { detailed: boolean }): Promise<FamilySignin[]> {
  const [links, loaded] = await Promise.all([
    db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(eq(guardian.familyQboId, familyQboId)),
    loadDecision(),
  ]);
  const others = (email: string | null) => (!o.detailed || !email ? null
    : loaded?.decision.held.find((h) => h.email === email)?.families.filter((f) => f.qboId !== familyQboId).map((f) => f.name) ?? null);
  const out: FamilySignin[] = links.map(({ g, p }) => ({ parentId: p.id, name: p.name, email: p.email,
    ...accessWords({ status: g.status, reason: g.disabledReason, blocked: p.blocked, otherFamilies: others(p.email) }) }));
  if (loaded?.settings.signin) {
    // A denial is already shown when a link in this family is owned by its address; one with no address can only be
    // matched by the QuickBooks record it came from.
    const owners = new Set(links.map(({ p }) => p.email));
    const sources = new Set(links.map(({ g }) => g.sourceQboId));
    for (const d of loaded.decision.denials) {
      if (d.familyQboId !== familyQboId || (d.email ? owners.has(d.email) : sources.has(d.sourceQboId))) continue;
      out.push({ parentId: null, name: d.name, email: d.email, ...accessWords({ status: "disabled", reason: d.reason, blocked: false, otherFamilies: others(d.email) }) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.email ?? "").localeCompare(b.email ?? ""));
}

/** The Parents page's review lists: held addresses waiting for a decision, and the decisions made (which can be reversed). */
export async function heldReview(): Promise<{ waiting: HeldAddress[]; decided: DecidedHold[] }> {
  const [loaded, rows] = await Promise.all([loadDecision(), db.select().from(heldAddress).orderBy(heldAddress.email)]);
  const decidedRows = rows.filter((r) => r.approvedFamilyQboIds.length || r.rejectedFamilyQboIds.length);
  const names = await familyNames(decidedRows.flatMap((r) => [...r.approvedFamilyQboIds, ...r.rejectedFamilyQboIds]));
  const staffIds = decidedRows.map((r) => r.decidedBy).filter((id): id is string => id !== null);
  const staff = new Map((staffIds.length ? await db.select({ id: staffUser.id, name: staffUser.name }).from(staffUser).where(inArray(staffUser.id, staffIds)) : []).map((s) => [s.id, s.name]));
  return {
    waiting: loaded?.settings.signin ? loaded.decision.held.filter((h) => h.pending) : [],
    decided: decidedRows.map((r) => ({ email: r.email, approved: r.approvedFamilyQboIds.map((f) => names.get(f)!), rejected: r.rejectedFamilyQboIds.map((f) => names.get(f)!),
      note: r.note, decidedAt: r.decidedAt?.toISOString() ?? null, decidedBy: r.decidedBy ? staff.get(r.decidedBy) ?? null : null })),
  };
}
