import { resolveParentSession, type ParentIdentity } from "@/lib/auth/resolve";
import { seedGuardian, seedParent, seedParentSession } from "./db";
import { SIGNINS_ON, addToCache, fam, par, seedParentSettings, seedShape, stu } from "./roster-cache";

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
};
export const FAMILY_B: ParentFamilySpec = {
  family: { qboId: "QBO-BRACKENMOOR-FAMILY-8001", name: "Brackenmoor Family" },
  parent: { qboId: "QBO-BRACKENMOOR-PARENT-8002", name: "Bettina Brackenmoor", email: "bettina.brackenmoor@family-b.example", phone: "737-555-0182" },
  students: [{ qboId: "QBO-BRACKENMOOR-STUDENT-8003", name: "Barnaby Brackenmoor" }, { qboId: "QBO-BRACKENMOOR-STUDENT-8004", name: "Briseis Brackenmoor" }],
};

const unique = (values: string[]) => [...new Set(values)];

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
 * parent page as each parent and searches for the other's markers. When a step gives families new data (invoices,
 * payments, forms), seed it here for both families and add its recognizable strings to each family's markers, so the
 * gate covers the new pages without being told about them.
 */
export async function seedTwoFamilies(): Promise<{ a: SeededParent; b: SeededParent }> {
  const a = await seedSignedInParent(FAMILY_A);
  const b = await seedSignedInParent(FAMILY_B);
  return { a, b };
}
