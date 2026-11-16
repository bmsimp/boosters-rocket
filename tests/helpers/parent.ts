import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { familyMoney, parentAuthSession, setting, type StoredInvoice } from "@/lib/db/schema";
import { resolveParentSession, type ParentIdentity } from "@/lib/auth/resolve";
import { formatMoney } from "@/lib/money/cents";
import { getRosterSource, SOURCE_KEY } from "@/lib/roster/source";
import { seedGuardian, seedParent, seedParentSession } from "./db";
import { SIGNINS_ON, addToCache, fam, par, seedParentSettings, seedShape, stu } from "./roster-cache";
import { seedTwoFamilySeason, type FamilySeason } from "./season";

/**
 * Signed-in parents for tests: the family as QuickBooks lists it (in the roster cache), the portal person, their link
 * to the family and a live session, as sign-ins from QuickBooks would have made them.
 *
 * This module only seeds. To run a page or an action as one of these parents, import tests/helpers/signed-in.ts and
 * call asParent(seeded.identity).
 */
export type ParentFamilySpec = {
  family: { qboId: string; name: string };
  parent: { qboId: string; name: string; email: string; phone: string };
  students: { qboId: string; name: string }[];
  /** The family's invoices as QuickBooks last gave them (seedFamilyMoney): open unless `paid`, with a Pay button when `payLink` is set. */
  invoices?: { number: string; cents: number; paid?: true; payLink?: string }[];
};

export type SeededParent = {
  /** What the portal resolves this parent's session to: pass it to asParent(). */
  identity: ParentIdentity;
  spec: ParentFamilySpec;
  session: { id: string; token: string };
  /**
   * Every string that belongs to this family and to nobody else: names (whole and word by word), QuickBooks ids, the
   * email address, the phone number, and the portal's own ids for the person, the link and the session. A page shown
   * to another family must contain none of them.
   */
  markers: string[];
  /** With seedTwoFamilies(): how the current season stands for this family, in the words its pages must show (tests/helpers/season.ts). */
  season?: FamilySeason;
};

/**
 * Two families whose every name, id, address and number is an unmistakable string found nowhere else, so a test can
 * search a page for any trace of the other family. The ids are not the short numbers QuickBooks gives ("12" would
 * match almost any page); the cache stores ids as text either way.
 */
export const FAMILY_A: ParentFamilySpec = {
  family: { qboId: "QBO-ALDERQUIST-FAMILY-7001", name: "Alderquist Family" },
  parent: { qboId: "QBO-ALDERQUIST-PARENT-7002", name: "Ansgar Alderquist", email: "ansgar.alderquist@family-a.example", phone: "512-555-0171" },
  students: [{ qboId: "QBO-ALDERQUIST-STUDENT-7003", name: "Aurelio Alderquist" }, { qboId: "QBO-ALDERQUIST-STUDENT-7004", name: "Azalea Alderquist" }],
  invoices: [
    { number: "INV-ALDERQUIST-7101", cents: 713107, payLink: "https://connect.intuit.com/t/scs-v1-alderquist-7101" },
    { number: "INV-ALDERQUIST-7102", cents: 715209 },
    { number: "INV-ALDERQUIST-7103", cents: 717311, paid: true },
  ],
};
export const FAMILY_B: ParentFamilySpec = {
  family: { qboId: "QBO-BRACKENMOOR-FAMILY-8001", name: "Brackenmoor Family" },
  parent: { qboId: "QBO-BRACKENMOOR-PARENT-8002", name: "Bettina Brackenmoor", email: "bettina.brackenmoor@family-b.example", phone: "737-555-0182" },
  students: [{ qboId: "QBO-BRACKENMOOR-STUDENT-8003", name: "Barnaby Brackenmoor" }, { qboId: "QBO-BRACKENMOOR-STUDENT-8004", name: "Briseis Brackenmoor" }],
  invoices: [
    { number: "INV-BRACKENMOOR-8201", cents: 824208, payLink: "https://connect.intuit.com/t/scs-v1-brackenmoor-8201" },
    { number: "INV-BRACKENMOOR-8202", cents: 826410 },
    { number: "INV-BRACKENMOOR-8203", cents: 828612, paid: true },
  ],
};

const unique = (values: string[]) => [...new Set(values)];

/** The QuickBooks company the seeded money was "read" from: the one seedConnected() connects (tests/helpers/qbo-stub.ts). */
export const MONEY_REALM = "9130000000000001";
const owed = (spec: ParentFamilySpec) => (spec.invoices ?? []).filter((i) => !i.paid).reduce((sum, i) => sum + i.cents, 0);

/**
 * What a family's money looks like on a page: each invoice's number and amount, the total owed, and the address behind
 * Pay. "open" leaves out what is paid: Home shows what is owed, and the Payments page shows both.
 */
export function moneyMarkers(spec: ParentFamilySpec, which: "all" | "open" = "all"): string[] {
  const invoices = (spec.invoices ?? []).filter((i) => which === "all" || !i.paid);
  if (!invoices.length) return [];
  return unique([...invoices.flatMap((i) => [i.number, formatMoney(i.cents), ...(i.payLink ? [i.payLink] : [])]), formatMoney(owed(spec))]);
}

/**
 * Stores a family's invoices as figures QuickBooks has just given (unless `readAt` says otherwise), so a parent page
 * shows them without asking QuickBooks. The roster cache is marked as read from MONEY_REALM unless it already names a
 * company.
 */
export async function seedFamilyMoney(spec: ParentFamilySpec, o: { readAt?: Date; balanceWithJobsCents?: number | null } = {}): Promise<void> {
  await db.insert(setting).values({ key: SOURCE_KEY, value: { realmId: MONEY_REALM } }).onConflictDoNothing();
  const invoices: StoredInvoice[] = (spec.invoices ?? []).map((i, n) => ({
    qboId: String(9001 + n), number: i.number, customerQboId: spec.family.qboId, forName: null, date: "2026-10-01", dueDate: i.paid ? null : "2026-12-01",
    totalCents: i.cents, balanceCents: i.paid ? 0 : i.cents, currency: "USD", payLink: i.payLink ?? null,
  }));
  const row = { realmId: await getRosterSource(), readAt: o.readAt ?? new Date(), invoices, totalCents: owed(spec), currency: "USD",
    balanceWithJobsCents: o.balanceWithJobsCents === undefined ? owed(spec) : o.balanceWithJobsCents };
  await db.insert(familyMoney).values({ familyQboId: spec.family.qboId, ...row }).onConflictDoUpdate({ target: familyMoney.familyQboId, set: row });
}

/** The strings that would give this family away. A step that gives families new data (invoices, forms) adds its markers here. */
function markersOf(spec: ParentFamilySpec, identity: ParentIdentity, session: { id: string; token: string }): string[] {
  const people = [spec.parent.name, ...spec.students.map((s) => s.name)];
  const phoneDigits = spec.parent.phone.replace(/\D/g, "");
  return unique([
    spec.family.name, spec.family.qboId,
    ...people, ...people.flatMap((name) => name.split(" ")),
    spec.parent.qboId, ...spec.students.map((s) => s.qboId),
    // The phone number as stored, as bare digits, and its last seven digits both ways, however a page formats it.
    spec.parent.email, spec.parent.phone, phoneDigits, spec.parent.phone.slice(-8), phoneDigits.slice(-7),
    identity.parentId, identity.guardianId, session.id, session.token,
    ...moneyMarkers(spec),
  ]);
}

/**
 * Seeds one family with a signed-in parent, adding to what is already in the database: a layered membership shape,
 * sign-ins switched on, the family, its parent and its students in the roster cache, the portal person, an active link
 * that names the QuickBooks record it came from, and a session with the family chosen. The identity returned is the one
 * the portal itself resolves from that session, so a fixture the portal would refuse fails here, not in the test.
 */
export async function seedSignedInParent(spec: ParentFamilySpec = FAMILY_A): Promise<SeededParent> {
  await seedShape();
  await seedParentSettings(SIGNINS_ON);
  await addToCache([
    fam(spec.family.qboId, spec.family.name),
    par(spec.parent.qboId, spec.parent.name, spec.family.qboId, spec.parent.email, { phone: spec.parent.phone }),
    ...spec.students.map((s) => stu(s.qboId, s.name, spec.family.qboId)),
  ]);
  const person = await seedParent({ name: spec.parent.name, email: spec.parent.email, phone: spec.parent.phone, welcomedAt: new Date() });
  await seedGuardian({ parentId: person.id, familyQboId: spec.family.qboId, status: "active", isPrimary: true, sourceQboId: spec.parent.qboId });
  const session = await seedParentSession(person.authUserId, { familyQboId: spec.family.qboId });
  const state = await resolveParentSession({ id: session.id, userId: person.authUserId, familyQboId: spec.family.qboId });
  if (state.status !== "ok") throw new Error(`seedSignedInParent: the portal would not sign ${spec.parent.name} in to ${spec.family.name} (session state "${state.status}")`);
  return { identity: state.identity, spec, session, markers: markersOf(spec, state.identity, session) };
}

/**
 * Family A and family B, each with its own signed-in parent and two students, and nothing in common. The fixture for
 * every test that asks "can one family see another's data": tests/integration/parent-isolation.test.ts renders every
 * parent page as each parent and searches for the other's markers. Each family has its own invoices (numbers, amounts
 * and a total found nowhere else). When a step gives families new data (forms, sign-ups), seed it here for both
 * families and add its recognizable strings to each family's markers, so the gate covers the new pages without being
 * told about them. The club has a current season (seedTwoFamilySeason): each family has its own ticks and a waiver, and
 * a requirement asked of it alone, whose title, id and waiver reason are among its markers.
 */
export async function seedTwoFamilies(): Promise<{ a: SeededParent; b: SeededParent }> {
  const a = await seedSignedInParent(FAMILY_A);
  const b = await seedSignedInParent(FAMILY_B);
  // Each family's invoices and total, stored as fresh figures: the money box and the Payments page show them as they are.
  await seedFamilyMoney(FAMILY_A);
  await seedFamilyMoney(FAMILY_B);
  const seasons = await seedTwoFamilySeason(FAMILY_A, FAMILY_B);
  a.season = seasons.a; a.markers.push(...seasons.a.markers);
  b.season = seasons.b; b.markers.push(...seasons.b.markers);
  return { a, b };
}

/**
 * A signed-in parent for a family the test has put in the roster cache itself, in whatever membership shape: the
 * portal person, an active link to `familyQboId` (naming the QuickBooks record it came from, or made by hand when
 * `sourceQboId` is left out) and a session with that family chosen. Switches sign-ins on. For the two standard
 * families use seedSignedInParent() and seedTwoFamilies(), which also give the markers.
 */
export async function seedParentIn(o: { familyQboId: string; name: string; email: string; phone?: string | null; sourceQboId?: string | null }): Promise<{ identity: ParentIdentity; session: { id: string; token: string } }> {
  await seedParentSettings(SIGNINS_ON);
  const person = await seedParent({ name: o.name, email: o.email, phone: o.phone ?? null, welcomedAt: new Date() });
  await seedGuardian({ parentId: person.id, familyQboId: o.familyQboId, status: "active", isPrimary: true, sourceQboId: o.sourceQboId ?? null });
  const session = await seedParentSession(person.authUserId, { familyQboId: o.familyQboId });
  return { identity: await identityNow(session.id), session };
}

/**
 * The identity the portal resolves for a seeded session now: after a test has given the person another family, or
 * changed a link, the one returned when the parent was seeded is out of date.
 */
export async function identityNow(sessionId: string): Promise<ParentIdentity> {
  const [s] = await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, sessionId));
  if (!s) throw new Error(`identityNow: there is no parent session ${sessionId}`);
  const state = await resolveParentSession({ id: s.id, userId: s.userId, familyQboId: s.familyQboId });
  if (state.status !== "ok") throw new Error(`identityNow: the portal would not sign this session in (session state "${state.status}")`);
  return state.identity;
}
