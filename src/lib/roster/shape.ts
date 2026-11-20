import { z } from "zod";
import { eq, sql, isNull, notInArray, or } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, setting, qboCustomerType, qboCustomer } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { QboOp } from "@/lib/quickbooks/connection";
import { withdrawAddressesNote } from "@/lib/parents/take-in-setting";

export const SHAPE_KEY = "membership.shape";
/** Postgres advisory lock held for the length of a refresh and of a shape save, so neither overlaps the other (spec §2 Refreshing). */
export const ROSTER_LOCK = 7461001;
/** The roster cache's billing address columns with nothing in them: a customer whose type the shape doesn't name keeps none. */
export const NO_ADDRESS_COLUMNS = {
  addressLine1: null, addressLine2: null, addressCity: null, addressRegion: null, addressPostalCode: null, addressCountry: null,
} as const;

/** How the club's membership is laid out in QuickBooks, by customer type ID (spec §1). */
export type MembershipShape =
  | { kind: "flat"; memberTypeIds: string[] }
  | { kind: "layered"; familyTypeId: string; studentTypeId: string | null; parentTypeId: string | null };
export type TypeRow = { qboId: string; name: string; active: boolean };
export type ShapeForm = { kind?: string; family?: string; student?: string; parent?: string; members?: string[] };

const id = z.string().min(1).max(64);
const stored = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flat"), memberTypeIds: z.array(id).min(1) }),
  z.object({ kind: z.literal("layered"), familyTypeId: id, studentTypeId: id.nullable(), parentTypeId: id.nullable() }),
]);

export async function getShape(tx?: Tx): Promise<MembershipShape | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SHAPE_KEY));
  const parsed = stored.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

/** The customer type IDs a shape names, in role order. */
export function shapeTypeIds(s: MembershipShape | null): string[] {
  if (!s) return [];
  return s.kind === "flat" ? s.memberTypeIds : [s.familyTypeId, s.studentTypeId, s.parentTypeId].filter((t): t is string => t !== null);
}

/**
 * Whether a shape lets a family have students: a layered one that names a student type. Only then does the portal add
 * a student, move one or change a linked one (shapeOperations() in ./operations.ts), and "Create a family from this"
 * makes student records only then, so a shape without one leaves records the portal adds none to (an unlinked one can
 * still be renamed or made inactive there), which must not decide who signs in: the Admin's "Families with no active
 * student" is in force only then
 * (studentsRuleInForce(), src/lib/parents/sessions.ts), and is switched on only then (src/lib/parents/switches.ts).
 */
export const shapeNamesStudents = (s: MembershipShape | null): boolean => s?.kind === "layered" && s.studentTypeId !== null;

/** Named types that aren't in QuickBooks' list any more: the shape is broken until an Admin chooses again. */
export function missingTypes(s: MembershipShape, types: TypeRow[]): string[] {
  const known = new Set(types.map((t) => t.qboId));
  return shapeTypeIds(s).filter((t) => !known.has(t));
}

/**
 * Whether the membership shape can be trusted to say whose customers are a family's: not when there is none, nor when
 * it names a customer type QuickBooks no longer has (the staff roster shows nothing then either). Before stage 3's
 * fourth slice a parent's money and buy-outs asked loadMyFamily() first, which went by the same rule; the family is the
 * app's own record now, so what still reads QuickBooks' tree for a parent asks this: a page load's money
 * (src/lib/money/family-money.ts) and a buy-out's offer, confirm and switch-back (src/lib/buyouts/). Parent code may
 * import it.
 */
export async function shapeHolds(tx?: Tx): Promise<boolean> {
  const [shape, types] = await Promise.all([getShape(tx), (tx ?? db).select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType)]);
  return shape !== null && missingTypes(shape, types).length === 0;
}

export function parseShapeForm(f: ShapeForm, types: TypeRow[]): { ok: true; shape: MembershipShape } | { ok: false; errors: string[] } {
  const known = new Set(types.map((t) => t.qboId));
  const pick = (v: string | undefined) => (v ?? "").trim() || null;
  const fail = (message: string) => ({ ok: false as const, errors: [message] });
  if (f.kind === "flat") {
    const members = [...new Set((f.members ?? []).map((m) => m.trim()).filter(Boolean))];
    if (!members.length) return fail("Choose at least one customer type for members.");
    if (members.some((m) => !known.has(m))) return fail("Choose customer types from the list.");
    return { ok: true, shape: { kind: "flat", memberTypeIds: members } };
  }
  if (f.kind === "layered") {
    const family = pick(f.family), student = pick(f.student), parent = pick(f.parent);
    if (!family) return fail("Choose which customer type is a family.");
    const named = [family, student, parent].filter((t): t is string => t !== null);
    if (named.some((t) => !known.has(t))) return fail("Choose customer types from the list.");
    if (new Set(named).size !== named.length) return fail("A customer type can have only one role.");
    return { ok: true, shape: { kind: "layered", familyTypeId: family, studentTypeId: student, parentTypeId: parent } };
  }
  return fail("Choose flat or layered.");
}

/** The shape in words, for the settings view and the audit log. */
export function describeShape(s: MembershipShape, types: TypeRow[]): string {
  const name = (t: string) => types.find((x) => x.qboId === t)?.name ?? "a type QuickBooks no longer has";
  if (s.kind === "flat") {
    const names = s.memberTypeIds.map(name);
    return `Flat: members are ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}.`;
  }
  const parts = [`families are ${name(s.familyTypeId)}`];
  if (s.studentTypeId) parts.push(`students are ${name(s.studentTypeId)}`);
  if (s.parentTypeId) parts.push(`parents are ${name(s.parentTypeId)}`);
  const blank = !s.studentTypeId && !s.parentTypeId ? " Students and parents aren't identified in QuickBooks."
    : !s.studentTypeId ? " Students aren't identified in QuickBooks." : !s.parentTypeId ? " Parents aren't identified in QuickBooks." : "";
  return `Layered: ${parts.join(", ")}.${blank}`;
}

/**
 * Saves the shape and, in the same transaction, drops email, phone and billing address from every customer the new shape doesn't name
 * (spec §1 Rules), withdraws the take-in's note that a roster read kept the billing addresses (withdrawAddressesNote(),
 * so the take-in waits for a read made under this shape) and forgets what each family was last seen to owe
 * (`family_money`), money's own rule. It changes none
 * of the app's own records (stage 3's slice 9c: they stand alone, whatever the shape calls each customer). It leaves
 * the parents' settings alone: "Families with no active student" is simply not in force while the shape names no
 * students (studentsRuleInForce(), src/lib/parents/sessions.ts), since the portal adds and moves students only while it does.
 * It waits for a running refresh first, and no refresh starts until it commits. The caller still starts
 * a refresh afterward to bring the rest of the cache up to date. A shape `getShape` wouldn't read back is refused (it
 * throws): saved, it would show as "no shape" while its audit row said otherwise.
 */
export async function saveShape(input: MembershipShape, o: QboOp): Promise<void> {
  const shape: MembershipShape = stored.parse(input);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const before = await getShape(tx);
    const types = await tx.select().from(qboCustomerType);
    await tx.insert(setting).values({ key: SHAPE_KEY, value: shape }).onConflictDoUpdate({ target: setting.key, set: { value: shape, updatedAt: new Date() } });
    const named = shapeTypeIds(shape);
    await tx.update(qboCustomer).set({ email: null, phone: null, ...NO_ADDRESS_COLUMNS })
      .where(named.length ? or(isNull(qboCustomer.typeQboId), notInArray(qboCustomer.typeQboId, named)) : undefined);
    // The cache holds no contact details yet for a type the shape names now and didn't before: the take-in of a
    // guardian's phone and address waits for a roster read made under this shape (src/lib/parents/contact-take-in.ts).
    await withdrawAddressesNote(tx);
    // The shape decides whose invoices are a family's, so what each family was last seen to owe was added up under the
    // old one. It goes, and each family's figures are read from QuickBooks again when its parent next looks.
    await tx.delete(familyMoney);
    await writeAudit({ actor: o.actor, action: "settings.membership.save", permission: o.permission, targetType: "setting", targetId: SHAPE_KEY, ip: o.ip,
      before: before ? { shape: before, words: describeShape(before, types) } : null, after: { shape, words: describeShape(shape, types) } }, tx);
  });
}
