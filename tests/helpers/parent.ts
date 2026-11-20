import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { familyMoney, parent, parentAuthAccount, parentAuthSession, parentAuthUser, setting, type StoredInvoice } from "@/lib/db/schema";
import { resolveParentSession, type ParentIdentity } from "@/lib/auth/resolve";
import { chooseFamily } from "@/lib/parents/family-choice";
import { formatMoney } from "@/lib/money/cents";
import { getRosterSource, SOURCE_KEY } from "@/lib/roster/source";
import { seedGuardian, seedParent, seedParentSession } from "./db";
import { SIGNINS_ON, addToCache, fam, par, seedParentSettings, seedShape, stu } from "./roster-cache";
import { TRIP_DEPOSIT_ITEM, seedTwoFamilySeason, type FamilySeason } from "./season";
import { seedTwoFamilyVolunteering, type FamilyVolunteer } from "./volunteer";
import { seedTwoFamilyForms, type FamilyForms } from "./forms";
import { seedTwoFamilyEmailChanges, type FamilyEmailChange } from "./email-change";
import { seedTwoFamilyBuyouts, type FamilyBuyout } from "./buyouts";
import { recordOfCustomer, syncAppRecords } from "./app-records";
import { seedDevice, seedPassword } from "./signin-links";

/** The password proveRecently() gives a person who has none: the door helper's (DOOR_PASSWORD, tests/helpers/parent-door.ts). */
export const PROVEN_PASSWORD = "the parents' long test password";

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
  /**
   * The family's invoices as QuickBooks last gave them (seedFamilyMoney): open unless `paid`, with a Pay button when
   * `payLink` is set, carrying the QuickBooks products and services in `items` (none unless given).
   */
  invoices?: { number: string; cents: number; paid?: true; payLink?: string; items?: string[] }[];
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
  /** With seedTwoFamilies(): the volunteer shift both families are signed up for, and this family's sign-up (tests/helpers/volunteer.ts). */
  volunteer?: FamilyVolunteer;
  /** With seedTwoFamilies(): this family's forms, a request in every state, and the words its Forms page must show (tests/helpers/forms.ts). */
  forms?: FamilyForms;
  /** With seedTwoFamilies(): this parent's pending change of sign-in address, its link's token and the new address (tests/helpers/email-change.ts). */
  emailChange?: FamilyEmailChange;
  /** With seedTwoFamilies(): this family's volunteer requirement with a buy-out, A's invoiced and B's paid (tests/helpers/buyouts.ts). */
  buyout?: FamilyBuyout;
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
    { number: "INV-ALDERQUIST-7103", cents: 717311, paid: true, items: [TRIP_DEPOSIT_ITEM] }, // the trip deposit, paid (tests/helpers/season.ts)
  ],
};
export const FAMILY_B: ParentFamilySpec = {
  family: { qboId: "QBO-BRACKENMOOR-FAMILY-8001", name: "Brackenmoor Family" },
  parent: { qboId: "QBO-BRACKENMOOR-PARENT-8002", name: "Bettina Brackenmoor", email: "bettina.brackenmoor@family-b.example", phone: "737-555-0182" },
  students: [{ qboId: "QBO-BRACKENMOOR-STUDENT-8003", name: "Barnaby Brackenmoor" }, { qboId: "QBO-BRACKENMOOR-STUDENT-8004", name: "Briseis Brackenmoor" }],
  invoices: [
    { number: "INV-BRACKENMOOR-8201", cents: 824208, payLink: "https://connect.intuit.com/t/scs-v1-brackenmoor-8201", items: [TRIP_DEPOSIT_ITEM] }, // the trip deposit, not paid yet
    { number: "INV-BRACKENMOOR-8202", cents: 826410 },
    { number: "INV-BRACKENMOOR-8203", cents: 828612, paid: true },
  ],
};

const unique = (values: string[]) => [...new Set(values)];

/**
 * Each standard family's person's mailing address, the portal's own (stage 3's slice 11a), given on their person row by
 * seedTwoFamilies(): every part an unmistakable string, so the parent isolation gate fails a page that shows the other's.
 */
export const PERSON_ADDRESS = {
  [FAMILY_A.parent.qboId]: { line1: "7011 Quillfeather Road", line2: "Quillfeather Annex 7012", city: "Quillfeather Springs", region: "QF", postalCode: "QF-70113", country: "Quillfeatheria" },
  [FAMILY_B.parent.qboId]: { line1: "8021 Wrenhallow Drive", line2: "Wrenhallow Annex 8022", city: "Wrenhallow Crossing", region: "WH", postalCode: "WH-80223", country: "Wrenhallowland" },
} as const;
/** Gives the family's person their mailing address on their person row, and returns its strings as markers (all but the short region). */
async function givePersonAddress(spec: ParentFamilySpec, parentId: string): Promise<string[]> {
  const a = PERSON_ADDRESS[spec.parent.qboId]!;
  await db.update(parent).set({ addressLine1: a.line1, addressLine2: a.line2, addressCity: a.city, addressRegion: a.region, addressPostalCode: a.postalCode, addressCountry: a.country })
    .where(eq(parent.id, parentId));
  return [a.line1, a.line2, a.city, a.postalCode, a.country];
}

/** The QuickBooks company the seeded money was "read" from: the one seedConnected() connects (tests/helpers/qbo-stub.ts). */
export const MONEY_REALM = "9130000000000001";
/** Marks the roster cache as read from MONEY_REALM, unless it already names a company. */
const markRosterCompany = () => db.insert(setting).values({ key: SOURCE_KEY, value: { realmId: MONEY_REALM } }).onConflictDoNothing();
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
  await markRosterCompany();
  const invoices: StoredInvoice[] = (spec.invoices ?? []).map((i, n) => ({
    qboId: String(9001 + n), number: i.number, customerQboId: spec.family.qboId, forName: null, date: "2026-10-01", dueDate: i.paid ? null : "2026-12-01",
    totalCents: i.cents, balanceCents: i.paid ? 0 : i.cents, currency: "USD", payLink: i.payLink ?? null, itemQboIds: i.items ?? [],
  }));
  const row = { realmId: await getRosterSource(), readAt: o.readAt ?? new Date(), invoices, totalCents: owed(spec), currency: "USD",
    balanceWithJobsCents: o.balanceWithJobsCents === undefined ? owed(spec) : o.balanceWithJobsCents };
  // Kept by the app's family, as the portal keeps it: the family customer's own record (an inactive one, with its link,
  // for a customer the roster doesn't hold as a family yet, as migration 0023 made one).
  const familyId = await recordOfCustomer(spec.family.qboId, "family");
  await db.insert(familyMoney).values({ familyId, ...row }).onConflictDoUpdate({ target: familyMoney.familyId, set: row });
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
 * that names the QuickBooks record it came from, and a session with the family chosen. The cache is marked as read from
 * MONEY_REALM unless it already names a company, as a roster read leaves it (and as seedFamilyMoney() does), so the
 * app's own records are made for the family in that company: the season finds the session's family through its link
 * (src/lib/seasons/my-season.ts). The records are brought into step before the session is resolved, as the gate lets
 * a parent in only through the row's active family record. The identity returned is the one the portal itself resolves
 * from that session (it carries the app's family, `familyId`), so a fixture the portal would refuse fails here, not in
 * the test.
 */
export async function seedSignedInParent(spec: ParentFamilySpec = FAMILY_A): Promise<SeededParent> {
  await markRosterCompany();
  await seedShape();
  await seedParentSettings(SIGNINS_ON);
  await addToCache([
    fam(spec.family.qboId, spec.family.name),
    par(spec.parent.qboId, spec.parent.name, spec.family.qboId, spec.parent.email, { phone: spec.parent.phone }),
    ...spec.students.map((s) => stu(s.qboId, s.name, spec.family.qboId)),
  ]);
  const person = await seedParent({ name: spec.parent.name, email: spec.parent.email, phone: spec.parent.phone, welcomedAt: new Date() });
  await seedGuardian({ parentId: person.id, familyQboId: spec.family.qboId, status: "active", isPrimary: true, sourceQboId: spec.parent.qboId });
  // The link names the family: the app's own records follow, as the reconcile that made the link would. Before the
  // session is made: it stores the row's own family record, as the sign-in does, and the gate lets a parent into a
  // family only through that active record.
  await syncAppRecords();
  const session = await seedParentSession(person.authUserId, { familyQboId: spec.family.qboId });
  const [stored] = await db.select({ familyId: parentAuthSession.familyId }).from(parentAuthSession).where(eq(parentAuthSession.id, session.id));
  const state = await resolveParentSession({ id: session.id, userId: person.authUserId, familyId: stored?.familyId ?? null });
  if (state.status !== "ok") throw new Error(`seedSignedInParent: the portal would not sign ${spec.parent.name} in to ${spec.family.name} (session state "${state.status}")`);
  return { identity: state.identity, spec, session, markers: markersOf(spec, state.identity, session) };
}

/** The app's own ids of a family and its students, as text. */
async function appIdsOf(spec: ParentFamilySpec): Promise<string[]> {
  return [String(await recordOfCustomer(spec.family.qboId, "family")), ...(await Promise.all(spec.students.map(async (s) => String(await recordOfCustomer(s.qboId, "student")))))];
}

/**
 * Family A and family B, each with its own signed-in parent and two students, and nothing in common.
 The fixture for
 * every test that asks "can one family see another's data": tests/integration/parent-isolation.test.ts renders every
 * parent page as each parent and searches for the other's markers. Each family has its own invoices (numbers, amounts
 * and a total found nowhere else). When a step gives families new data (forms, sign-ups), seed it here for both
 * families and add its recognizable strings to each family's markers, so the gate covers the new pages without being
 * told about them. The club has a current season (seedTwoFamilySeason): each family has its own ticks and a waiver, and
 * a requirement asked of it alone, whose title, id and waiver reason are among its markers. Each also has forms to sign
 * (seedTwoFamilyForms): a request in every state, and one form asked of it alone. And one volunteer shift that both
 * families have signed up for (seedTwoFamilyVolunteering), whose sign-up ids are among their markers. Each parent has
 * a remembered device their session was made on, whose id is among their markers. Last, the app's
 * own records and links for both families (stage 1 of the app-owned families spec), as a roster read makes them.
 */
export async function seedTwoFamilies(): Promise<{ a: SeededParent; b: SeededParent }> {
  const a = await seedSignedInParent(FAMILY_A);
  const b = await seedSignedInParent(FAMILY_B);
  // Each person's phone (on their row already) and mailing address, the portal's own: /family/details shows them.
  a.markers.push(...(await givePersonAddress(FAMILY_A, a.identity.parentId)));
  b.markers.push(...(await givePersonAddress(FAMILY_B, b.identity.parentId)));
  // Each family's invoices and total, stored as fresh figures: the money box and the Payments page show them as they are.
  await seedFamilyMoney(FAMILY_A);
  await seedFamilyMoney(FAMILY_B);
  const seasons = await seedTwoFamilySeason(FAMILY_A, FAMILY_B);
  a.season = seasons.a; a.markers.push(...seasons.a.markers);
  b.season = seasons.b; b.markers.push(...seasons.b.markers);
  // One volunteer shift with a place taken by each family: each parent sees the count and their own sign-up alone.
  // A's student is checked in on it; B has credit for volunteering done outside the portal, with a note for staff only.
  const volunteering = await seedTwoFamilyVolunteering({ spec: FAMILY_A, parentId: a.identity.parentId }, { spec: FAMILY_B, parentId: b.identity.parentId }, seasons.season);
  a.volunteer = volunteering.a; a.markers.push(...volunteering.a.markers); a.season.staffOnly.push(...volunteering.a.staffOnly);
  b.volunteer = volunteering.b; b.markers.push(...volunteering.b.markers); b.season.staffOnly.push(...volunteering.b.staffOnly);
  // Forms in that season: one asked of each family alone, and a request in every state for both. Forms are not set up
  // (no Documenso is stored), so the pages show what is stored and nothing calls out.
  const forms = await seedTwoFamilyForms({ spec: FAMILY_A, parentId: a.identity.parentId }, { spec: FAMILY_B, parentId: b.identity.parentId }, seasons.season);
  a.forms = forms.a; a.markers.push(...forms.a.markers);
  b.forms = forms.b; b.markers.push(...forms.b.markers);
  // Each parent has a remembered device, the one their session was made on (slice SI-5b): its id, which their sign-in
  // settings list, and its token, which no page ever holds, are their markers.
  for (const p of [a, b]) {
    const device = await seedDevice(p.identity.parentId);
    await db.update(parentAuthSession).set({ deviceId: device.id }).where(eq(parentAuthSession.id, p.identity.sessionId));
    p.markers.push(device.id, device.token);
  }
  // Each parent has asked to change their sign-in address: the new address and the link's token are their markers.
  const emails = await seedTwoFamilyEmailChanges(a, b);
  a.emailChange = emails.a; a.markers.push(...emails.a.markers);
  b.emailChange = emails.b; b.markers.push(...emails.b.markers);
  // A volunteer requirement with a buy-out asked of each family alone: A's is invoiced, B's paid.
  const buyouts = await seedTwoFamilyBuyouts({ spec: FAMILY_A, parentId: a.identity.parentId }, { spec: FAMILY_B, parentId: b.identity.parentId }, seasons.season);
  a.buyout = buyouts.a; a.markers.push(...buyouts.a.markers);
  b.buyout = buyouts.b; b.markers.push(...buyouts.b.markers);
  // The app's own families, students and links for both, made by the import, as migration 0023 made them
  // (src/lib/families/roster-import.ts), so a test that reads them finds them. Their ids are markers too: the season keeps
  // its records by them (stage 2 of the app-owned families spec), and no page of one family may carry the other's.
  await syncAppRecords();
  a.markers.push(...(await appIdsOf(FAMILY_A)));
  b.markers.push(...(await appIdsOf(FAMILY_B)));
  return { a, b };
}

/**
 * A signed-in parent for a family the test has put in the roster cache itself, in whatever membership shape: the
 * portal person, an active link to `familyQboId` (naming the QuickBooks record it came from, or made by hand when
 * `sourceQboId` is left out) and a session with that family chosen, with the app's own records brought into step (in
 * MONEY_REALM, unless the cache names a company already). Switches sign-ins on. For the two standard
 * families use seedSignedInParent() and seedTwoFamilies(), which also give the markers.
 */
export async function seedParentIn(o: { familyQboId: string; name: string; email: string; phone?: string | null; sourceQboId?: string | null }): Promise<{ identity: ParentIdentity; session: { id: string; token: string } }> {
  await markRosterCompany();
  await seedParentSettings(SIGNINS_ON);
  const person = await seedParent({ name: o.name, email: o.email, phone: o.phone ?? null, welcomedAt: new Date() });
  await seedGuardian({ parentId: person.id, familyQboId: o.familyQboId, status: "active", isPrimary: true, sourceQboId: o.sourceQboId ?? null });
  await syncAppRecords();
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
  const state = await resolveParentSession({ id: s.id, userId: s.userId, familyId: s.familyId });
  if (state.status !== "ok") throw new Error(`identityNow: the portal would not sign this session in (session state "${state.status}")`);
  return state.identity;
}

/**
 * Gives the seeded parent a password, unless they have one, and stamps their session as having proved the password and
 * the second step just now (`strong_at`, as a sign-in or asking again stamps it: slice SI-5a), so a change of how they
 * sign in (their password, their sign-in email) goes ahead without asking again for the next 10 minutes.
 */
export async function proveRecently(identity: ParentIdentity, password = PROVEN_PASSWORD, at = new Date()): Promise<void> {
  const [user] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, identity.parentId));
  if (!user) throw new Error(`proveRecently: ${identity.email} has no sign-in account`);
  const credential = and(eq(parentAuthAccount.userId, user.id), eq(parentAuthAccount.providerId, "credential"));
  const has = await db.select({ id: parentAuthAccount.id }).from(parentAuthAccount).where(credential);
  // The password was chosen a moment before the proof, by the test's own clock (a change refuses a password replaced
  // since the proof, and the database's clock may run a little ahead of the test's).
  const chosen = new Date(at.getTime() - 1000);
  if (has.length === 0) await seedPassword(user.id, password, chosen);
  else await db.update(parentAuthAccount).set({ updatedAt: chosen }).where(credential);
  await db.update(parentAuthSession).set({ strongAt: at }).where(eq(parentAuthSession.id, identity.sessionId));
}

/**
 * The identity of a seeded session once it has chosen its family again. The session stores the app's own family record
 * it chose; when a test makes that record stop counting (the roster comes to name another company, so the person's row
 * names the record made from it), the gate sends the session back to the chooser, as it would the parent. This chooses,
 * through the portal's own chooseFamily(), the one family the person may still enter, and throws for anything else.
 */
export async function identityAfterChoosingAgain(sessionId: string): Promise<ParentIdentity> {
  const [s] = await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, sessionId));
  if (!s) throw new Error(`identityAfterChoosingAgain: there is no parent session ${sessionId}`);
  const state = await resolveParentSession({ id: s.id, userId: s.userId, familyId: s.familyId });
  if (state.status !== "choose") throw new Error(`identityAfterChoosingAgain: the session is not at the chooser (session state "${state.status}")`);
  if (state.families.length !== 1) throw new Error(`identityAfterChoosingAgain: the person may enter ${state.families.length} families, not one`);
  const chosen = await chooseFamily({ sessionId, parentId: state.parentId, guardianId: state.families[0]!.guardianId, ip: null });
  if (!chosen) throw new Error("identityAfterChoosingAgain: the portal refused the family the chooser offered");
  return identityNow(sessionId);
}
