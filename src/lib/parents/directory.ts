// Privacy: `listPeople` and `getPerson` return other families' names or a block reason. Use them only on pages behind
// `Parents.ReadWrite`, never behind `Roster.Read`. `familySignins` returns one family's own guardians, for its page.
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, parent, qboCustomer, type DisabledReason, type GuardianStatus } from "@/lib/db/schema";
import { hasActiveStudent, studentsRuleInForce } from "./sessions";
import { familyLabel } from "@/app/components/family-label";
import type { AppFamilyId } from "@/lib/families/ids";

export type AccessKind = "can" | "cannot" | "blocked";
/** One guardian row of a family, open or closed, and its person, with whether they can sign in to it, in words. */
export type FamilySignin = { guardianId: string; parentId: string; name: string; email: string; kind: AccessKind; words: string };
/**
 * `previousCompany`: the link was closed when a different QuickBooks company was connected. Its `familyQboId` is the
 * old company's, so a page shows the family name as text and never links it to, or looks it up in, the roster.
 * `familyId`: the membership's own app family (`guardian.family_id`), which the family's page is addressed by; null for
 * a previous company's link, which has none.
 */
export type PersonFamily = { familyQboId: string; familyId: AppFamilyId | null; familyName: string; previousCompany: boolean; kind: AccessKind; words: string };
export type PersonRow = { parentId: string; name: string; email: string; blocked: boolean; families: PersonFamily[]; lastSigninAt: string | null; welcomedAt: string | null };
export type PersonDetail = PersonRow & { blockedReason: string | null; blockedAt: string | null; welcomeOwed: boolean };
/**
 * Why a row was closed, in words. Rows the retired reconcile closed for something QuickBooks held keep their reason, and
 * these words, for good: nothing reopens them for it (stage 3 of the app-owned families spec).
 */
const WHY: Record<DisabledReason, string> = {
  inactive: "inactive in QuickBooks", family_inactive: "the family is inactive in QuickBooks", no_email: "no email address in QuickBooks",
  no_active_students: "the family has no active students", not_in_quickbooks: "not listed under this family in QuickBooks",
  address_changed: "the email address changed in QuickBooks", company_changed: "a different QuickBooks company was connected",
  removed: "removed by staff", held: "the address was under more than one family, and held for staff to review",
};

/**
 * Why an open row's family is not one its person can enter now, by the gate's rule (enterableGuardianRows(),
 * ./sessions.ts): no family record, an inactive one, or none with an active student while the Admin asks for one.
 * `counts` when it is one to enter. Nothing closes the row for any of these: the gate keeps its person out.
 */
export type FamilyStanding = "counts" | "no_record" | "inactive" | "no_students";
const NOT_NOW: Record<Exclude<FamilyStanding, "counts">, string> = {
  no_record: "the family isn't set up in the portal", inactive: "the family is inactive", no_students: "the family has no active students",
};

/**
 * One person's standing in one family, in plain words (spec §4 The roster): the row's own status and closing reason,
 * and for an open row whether its family counts at the gate now (`family`, counting when not given).
 */
export function accessWords(o: { status: GuardianStatus; reason: DisabledReason | null; blocked: boolean; family?: FamilyStanding }): { kind: AccessKind; words: string } {
  if (o.status === "disabled") return { kind: "cannot", words: o.reason ? `Can't sign in: ${WHY[o.reason]}` : "Can't sign in" };
  if (o.blocked) return { kind: "blocked", words: "Blocked" };
  if (o.family && o.family !== "counts") return { kind: "cannot", words: `Can't sign in now: ${NOT_NOW[o.family]}` };
  return { kind: "can", words: o.status === "invited" ? "Can sign in (hasn't yet)" : "Can sign in" };
}

/**
 * FamilyStanding of each family record named, read as the gate reads it: the students rule as it is in force
 * (studentsRuleInForce()) and a family's active students by the gate's own condition (hasActiveStudent()), so staff
 * never read "can't" where the gate lets the person in.
 */
async function familyStandings(ids: (AppFamilyId | null)[]): Promise<(id: AppFamilyId | null) => FamilyStanding> {
  const unique = [...new Set(ids.filter((id): id is AppFamilyId => id !== null))];
  const [studentsRule, rows, withStudents] = await Promise.all([studentsRuleInForce(),
    unique.length ? db.select({ id: family.id, active: family.active }).from(family).where(inArray(family.id, unique)) : Promise.resolve([]),
    unique.length ? db.select({ id: family.id }).from(family).where(and(inArray(family.id, unique), hasActiveStudent(family.id))) : Promise.resolve([])]);
  const found = new Map(rows.map((r) => [String(r.id), r]));
  const hasStudent = new Set(withStudents.map((r) => String(r.id)));
  return (id) => {
    const f = id === null ? undefined : found.get(String(id));
    if (!f) return "no_record";
    if (!f.active) return "inactive";
    return studentsRule && !hasStudent.has(String(f.id)) ? "no_students" : "counts";
  };
}

/** Family names from the roster cache, for showing a family to staff. A parent's pages use myFamilyNames() (./my-family-names.ts). */
export async function familyNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(inArray(qboCustomer.qboId, unique)) : [];
  const found = new Map(rows.map((r) => [r.qboId, r.name]));
  return new Map(unique.map((id) => [id, found.get(id) ?? familyLabel(id)]));
}

const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
/** The label for a link closed by a company change, in place of a family name. */
export const PREVIOUS_COMPANY_FAMILY = "A family in the previous QuickBooks company";
const oldCompany = (l: { disabledReason: DisabledReason | null }) => l.disabledReason === "company_changed";

async function people(where?: ReturnType<typeof eq>): Promise<PersonDetail[]> {
  const persons = await db.select().from(parent).where(where).orderBy(parent.name, parent.email);
  if (!persons.length) return [];
  const ids = persons.map((p) => p.id);
  const [links, signins] = await Promise.all([
    db.select().from(guardian).where(inArray(guardian.parentId, ids)),
    db.select({ id: auditLog.targetId, at: max(auditLog.at) }).from(auditLog)
      .where(and(eq(auditLog.action, "signin"), eq(auditLog.door, "parent"), inArray(auditLog.targetId, ids))).groupBy(auditLog.targetId),
  ]);
  // A link from a previous company holds that company's family ID, which names some other family (or none) in the
  // connected one: it is never looked up in the cache.
  const [names, standing] = await Promise.all([familyNames(links.filter((l) => !oldCompany(l)).map((l) => l.familyQboId)), familyStandings(links.map((l) => l.familyId))]);
  const last = new Map(signins.map((s) => [s.id, s.at]));
  return persons.map((p) => ({
    parentId: p.id, name: p.name, email: p.email, blocked: p.blocked,
    families: links.filter((l) => l.parentId === p.id).sort((a, b) => Number(oldCompany(a)) - Number(oldCompany(b)) || numeric(a.familyQboId, b.familyQboId)).map((l) => ({
      familyQboId: l.familyQboId, familyId: oldCompany(l) ? null : l.familyId, familyName: oldCompany(l) ? PREVIOUS_COMPANY_FAMILY : names.get(l.familyQboId)!, previousCompany: oldCompany(l),
      ...accessWords({ status: l.status, reason: l.disabledReason, blocked: p.blocked, family: standing(l.familyId) }) })),
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
 * The **Portal sign-ins** box on a family's roster page: every guardian row whose membership is in the family's own
 * record (`guardian.family_id`), open or closed, with its person, in words. Nothing is worked out from QuickBooks: a
 * row is a sign-in the app holds, and the words are its own status and closing reason, and for an open row whether the
 * family is one to enter now by the gate's rule (accessWords(), familyStandings()).
 */
export async function familySignins(familyId: AppFamilyId): Promise<FamilySignin[]> {
  // A link from a previous company is in no family's record (its family_id is null): it is not one of this family's sign-ins.
  const links = await db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(eq(guardian.familyId, familyId), sql`${guardian.disabledReason} is distinct from 'company_changed'`));
  const standing = await familyStandings([familyId]);
  return links.map(({ g, p }): FamilySignin => ({ guardianId: g.id, parentId: p.id, name: p.name, email: p.email,
    ...accessWords({ status: g.status, reason: g.disabledReason, blocked: p.blocked, family: standing(g.familyId) }) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.email.localeCompare(b.email) || (a.guardianId < b.guardianId ? -1 : 1));
}
