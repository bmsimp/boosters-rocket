// Privacy: `listPeople` and `getPerson` return other families' names or a block reason. Use them only on pages behind
// `Parents.ReadWrite`, never behind `Roster.Read`. `familySignins` returns one family's own guardians, for its page.
// `personContact` and `familyContact` return a person's or a family's phone and mailing address (stage 3's slice 11c):
// only for a person's page, or a family's page to a reader holding Roster.Family.ReadWrite or Parents.ReadWrite, each
// audited before it shows anything; never on a list page.
// Beside them, the accounting links screen (/staff/links, src/lib/accounting/mapping.ts) lists every family's open
// guardians' names and sign-in addresses in one list, behind the linking permission with Roster.Read; never a block
// reason. Of the sign-in state it says only that a blocked person can't sign in (as a family's own page, behind
// Roster.Read, shows them blocked), and it never matches a blocked person's address to a customer.
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, parent, qboCustomer, type DisabledReason, type GuardianStatus } from "@/lib/db/schema";
import { GUARDIAN_COLS, hasActiveStudent, studentsRuleInForce } from "./sessions";
import { familyLabel } from "@/app/components/family-label";
import type { AppFamilyId } from "@/lib/families/ids";
import { linksOf } from "@/lib/families/links";
import { recordNameWords } from "@/lib/families/words";
import { formVersion, type ContactForm } from "./contact-fields";

export type AccessKind = "can" | "cannot" | "blocked";
/**
 * One guardian row of a family, open or closed, and its person, with whether they can sign in to it, in words. `open`:
 * the row is open, so staff may remove it; `reinstatable`: it is closed, and staff may open it again (stage 3's slice
 * 7b: any closed row but one a change of company closed, which is in no family's list).
 */
export type FamilySignin = { guardianId: string; parentId: string; name: string; email: string; kind: AccessKind; words: string; open: boolean; reinstatable: boolean };
/**
 * `previousCompany`: the link was closed when a different QuickBooks company was connected: a page shows the family
 * name as text and never links it to, or looks it up in, the roster. `familyId`: the membership's own app family
 * (`guardian.family_id`), which the family's page is addressed by; null for a previous company's link, which has none.
 * `familyQboId`: the customer the family record's own link names (stage 3's slice 12b1), null for a family with no link
 * and for a previous company's row; the family is named from its record. `pageStands`: the family's staff page stands
 * for it (an active record, or one with a link), so it may be linked to; an inactive family with no link (made inactive
 * in the portal) has no page.
 */
export type PersonFamily = { guardianId: string; familyQboId: string | null; familyId: AppFamilyId | null; familyName: string; previousCompany: boolean; pageStands: boolean;
  kind: AccessKind; words: string; open: boolean; reinstatable: boolean };
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
 * ./sessions.ts): no family record, an inactive one, one whose sign-ins are held after a take from the books (stage 4's
 * slice M4b), or none with an active student while the Admin asks for one.
 * `counts` when it is one to enter. Nothing closes the row for any of these: the gate keeps its person out.
 */
export type FamilyStanding = "counts" | "no_record" | "inactive" | "held" | "no_students";
const NOT_NOW: Record<Exclude<FamilyStanding, "counts">, string> = {
  no_record: "the family isn't set up in the portal", inactive: "the family is inactive",
  held: "the family was made active again from the books, and its guardians wait for someone who may change families to let them in on its page",
  no_students: "the family has no active students",
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
    unique.length ? db.select({ id: family.id, active: family.active, held: family.signinHeldAt }).from(family).where(inArray(family.id, unique)) : Promise.resolve([]),
    unique.length ? db.select({ id: family.id }).from(family).where(and(inArray(family.id, unique), hasActiveStudent(family.id))) : Promise.resolve([])]);
  const found = new Map(rows.map((r) => [String(r.id), r]));
  const hasStudent = new Set(withStudents.map((r) => String(r.id)));
  return (id) => {
    const f = id === null ? undefined : found.get(String(id));
    if (!f) return "no_record";
    if (!f.active) return "inactive";
    if (f.held !== null) return "held";
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
/**
 * A person's rows in the order the Parents pages list them: a previous company's last; then by the customer each
 * family's own link names, as numbers; then the rows of families with no link, by row id. As the chooser's order
 * (enterableGuardianRows()), a row of a family linked since it was made, or relinked after an unlink, sorts by its
 * family's customer now; while QuickBooks is connected to another company than the records' no link is read, and the
 * rows of the current company come by row id.
 */
type Placed = { id: string; disabledReason: DisabledReason | null; customer: string | null };
const byCustomerThenRow = (a: Placed, b: Placed) =>
  Number(oldCompany(a)) - Number(oldCompany(b)) || Number(a.customer === null) - Number(b.customer === null)
  || (a.customer !== null && b.customer !== null ? numeric(a.customer, b.customer) : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** The label for a link closed by a company change, in place of a family name. */
export const PREVIOUS_COMPANY_FAMILY = "A family in the previous QuickBooks company";
const oldCompany = (l: { disabledReason: DisabledReason | null }) => l.disabledReason === "company_changed";
/** What staff may do with a row (src/lib/parents/guardians.ts): remove an open one, reinstate a closed one but a previous company's. */
const rowActions = (l: { status: GuardianStatus; disabledReason: DisabledReason | null }) =>
  ({ open: l.status !== "disabled", reinstatable: l.status === "disabled" && !oldCompany(l) });

async function people(where?: ReturnType<typeof eq>): Promise<PersonDetail[]> {
  const persons = await db.select().from(parent).where(where).orderBy(parent.name, parent.email);
  if (!persons.length) return [];
  const ids = persons.map((p) => p.id);
  const [links, signins] = await Promise.all([
    db.select(GUARDIAN_COLS).from(guardian).where(inArray(guardian.parentId, ids)),
    db.select({ id: auditLog.targetId, at: max(auditLog.at) }).from(auditLog)
      .where(and(eq(auditLog.action, "signin"), eq(auditLog.door, "parent"), inArray(auditLog.targetId, ids))).groupBy(auditLog.targetId),
  ]);
  // A link from a previous company is in no family record, and is never looked up in the cache. A row in a family
  // record is named from the record, as the chooser names it, and one with none in words.
  const current = links.filter((l) => !oldCompany(l));
  const recordIds = [...new Set(current.flatMap((l) => (l.familyId === null ? [] : [l.familyId])))];
  const [records, standing, linked] = await Promise.all([
    recordIds.length ? db.select({ id: family.id, name: family.name }).from(family).where(inArray(family.id, recordIds)) : Promise.resolve([]),
    familyStandings(links.map((l) => l.familyId)), linksOf({ families: recordIds, students: [] })]);
  // The family's page stands for an active record, linked or not, and for an inactive one through its link (as the
  // queue's links to it are offered, loadOpenWrites()): an inactive family with no link has none to open.
  const pageStands = (id: AppFamilyId | null) => id !== null && (!["inactive", "no_record"].includes(standing(id)) || linked.customerOfFamily.has(id));
  const recordName = new Map(records.map((r) => [String(r.id), recordNameWords(r.name, "family")]));
  const nameOf = (l: (typeof links)[number]) => (oldCompany(l) ? PREVIOUS_COMPANY_FAMILY
    : (l.familyId !== null ? recordName.get(String(l.familyId)) : undefined) ?? recordNameWords(null, "family"));
  // The customer of the row's family record, through the family's own link: none for a previous company's row.
  const customerOf = (l: (typeof links)[number]) => (oldCompany(l) || l.familyId === null ? null : linked.customerOfFamily.get(l.familyId) ?? null);
  const last = new Map(signins.map((s) => [s.id, s.at]));
  return persons.map((p) => ({
    parentId: p.id, name: p.name, email: p.email, blocked: p.blocked,
    families: links.filter((l) => l.parentId === p.id).map((l) => ({ l, customer: customerOf(l) }))
      .sort((a, b) => byCustomerThenRow({ ...a.l, customer: a.customer }, { ...b.l, customer: b.customer })).map(({ l, customer }) => ({
      guardianId: l.id, familyQboId: customer, familyId: oldCompany(l) ? null : l.familyId, familyName: nameOf(l), previousCompany: oldCompany(l),
      pageStands: !oldCompany(l) && pageStands(l.familyId),
      ...accessWords({ status: l.status, reason: l.disabledReason, blocked: p.blocked, family: standing(l.familyId) }), ...rowActions(l) })),
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
  const links = await db.select({ g: GUARDIAN_COLS, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(eq(guardian.familyId, familyId), sql`${guardian.disabledReason} is distinct from 'company_changed'`));
  const standing = await familyStandings([familyId]);
  return links.map(({ g, p }): FamilySignin => ({ guardianId: g.id, parentId: p.id, name: p.name, email: p.email,
    ...accessWords({ status: g.status, reason: g.disabledReason, blocked: p.blocked, family: standing(g.familyId) }), ...rowActions(g) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.email.localeCompare(b.email) || (a.guardianId < b.guardianId ? -1 : 1));
}

/** The details columns of a person's or a family's row. */
const detailColumns = (t: typeof parent | typeof family) => ({ phone: t.phone, addressLine1: t.addressLine1, addressLine2: t.addressLine2, addressCity: t.addressCity,
  addressRegion: t.addressRegion, addressPostalCode: t.addressPostalCode, addressCountry: t.addressCountry, contactVersion: t.contactVersion });
type DetailRow = { phone: string | null; addressLine1: string | null; addressLine2: string | null; addressCity: string | null; addressRegion: string | null;
  addressPostalCode: string | null; addressCountry: string | null; contactVersion: number };
const formOfRow = (whose: "person" | "family", r: DetailRow): ContactForm => ({ version: formVersion(whose, r.contactVersion),
  values: { phone: r.phone ?? "", line1: r.addressLine1 ?? "", line2: r.addressLine2 ?? "", city: r.addressCity ?? "", region: r.addressRegion ?? "",
    postalCode: r.addressPostalCode ?? "", country: r.addressCountry ?? "" } });

/**
 * A person's phone and mailing address as the portal holds them (`parent`'s columns), with the version the staff form
 * sends back (`p:<n>`), for the person's page (stage 3's slice 11c), which is behind Parents.ReadWrite and audited
 * (`parent.read`) before it shows them. Null for no such person.
 */
export async function personContact(parentId: string): Promise<ContactForm | null> {
  if (!/^[0-9a-f-]{36}$/i.test(parentId)) return null;
  const [r] = await db.select(detailColumns(parent)).from(parent).where(eq(parent.id, parentId));
  return r ? formOfRow("person", r) : null;
}
/**
 * A family record's phone and mailing address as the portal holds them (`family`'s columns, books with no parent type),
 * with the version the staff form sends back (`f:<n>`), for the family's page (stage 3's slice 11c), which shows them
 * only to a reader holding Roster.Family.ReadWrite or Parents.ReadWrite, after its `roster.family.read`. Null for none.
 */
export async function familyContact(familyId: AppFamilyId): Promise<ContactForm | null> {
  const [r] = await db.select(detailColumns(family)).from(family).where(eq(family.id, familyId));
  return r ? formOfRow("family", r) : null;
}
