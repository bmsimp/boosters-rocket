// Volunteer buy-outs in tests (src/lib/buyouts/): a volunteer requirement that offers one, a buy-out row as the
// portal leaves it in each state, and a family whose ids are digits, connected through the QuickBooks stub, so its
// invoices are really made and voided there (tests/helpers/qbo-stub.ts).
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, requirement, requirementCover, season, seasonStep, writeQueue, type BuyoutState } from "@/lib/db/schema";
import { formatMoney } from "@/lib/money/cents";
import { connectCompany, RIVERA } from "./money";
import { MONEY_REALM, seedSignedInParent, type ParentFamilySpec, type SeededParent } from "./parent";
import type { QboStub } from "./qbo-stub";
import type { SeededSeason } from "./season";
import { subjectColumns } from "./app-records";

/** The QuickBooks product or service the test buy-outs are billed with. */
export const BUYOUT_ITEM = "4343";

/** A volunteer requirement that offers a buy-out, in the current season (made if there is none) or in `stepId`. */
export async function seedBuyoutRequirement(o: { title?: string; appliesTo?: "family" | "student"; amount?: number; unit?: "shifts" | "hours"; unitCents?: number | null;
  item?: string | null; chosen?: string[]; required?: boolean; stepId?: string } = {}): Promise<string> {
  let stepId = o.stepId;
  if (!stepId) {
    const [current] = await db.select().from(season).where(eq(season.isCurrent, true));
    const s = current ?? (await db.insert(season).values({ name: "Buy-out season", isCurrent: true }).returning())[0]!;
    const [step] = await db.select().from(seasonStep).where(eq(seasonStep.seasonId, s.id)).orderBy(desc(seasonStep.position)).limit(1);
    stepId = step?.id ?? (await db.insert(seasonStep).values({ seasonId: s.id, name: "Volunteer", position: 0 }).returning())[0]!.id;
  }
  const [r] = await db.insert(requirement).values({ stepId, kind: "volunteer", title: o.title ?? "Concession shifts", required: o.required ?? true, appliesTo: o.appliesTo ?? "family",
    amount: o.amount ?? 2, amountUnit: o.unit ?? "shifts", covers: o.chosen ? "chosen" : "everyone", position: 50,
    buyoutUnitCents: o.unitCents === undefined ? 5000 : o.unitCents, itemQboId: o.item === undefined ? BUYOUT_ITEM : o.item }).returning();
  // A chosen list names the app's own records (stage 2 of the app-owned families spec), given here by QuickBooks id.
  for (const subjectQboId of o.chosen ?? []) await db.insert(requirementCover).values({ requirementId: r!.id, ...(await subjectColumns(subjectQboId, o.appliesTo ?? "family")) });
  return r!.id;
}

/** A buy-out as the portal leaves it, straight into the table. */
export async function seedBuyout(o: { requirementId: string; familyQboId: string; subjectQboId?: string; customerQboId?: string; chosenBy: string; state?: BuyoutState;
  unitCents?: number; units?: number; invoiceQboId?: string | null; item?: string; realmId?: string; flag?: (typeof buyout.$inferSelect)["flag"] }) {
  const unitCents = o.unitCents ?? 5000, units = o.units ?? 2, state = o.state ?? "invoiced";
  const [row] = await db.insert(buyout).values({
    requirementId: o.requirementId, familyQboId: o.familyQboId, subjectQboId: o.subjectQboId ?? o.familyQboId, customerQboId: o.customerQboId ?? o.subjectQboId ?? o.familyQboId,
    itemQboId: o.item ?? BUYOUT_ITEM, unitCents, units, amountCents: unitCents * units, state, realmId: o.realmId ?? MONEY_REALM, chosenBy: o.chosenBy, chosenByLabel: "a guardian",
    invoiceQboId: o.invoiceQboId === undefined ? (state === "being_invoiced" ? null : "5001") : o.invoiceQboId, invoiceSyncToken: "0", flag: o.flag ?? null, flaggedAt: o.flag ? new Date() : null,
  }).returning();
  return row!;
}

/** A family whose ids are digits (RIVERA unless given), signed in, with QuickBooks connected to the company its roster came from. */
export async function buyoutFamily(stub: QboStub, spec: ParentFamilySpec = RIVERA): Promise<SeededParent> {
  const seeded = await seedSignedInParent(spec);
  await connectCompany(stub);
  return seeded;
}

export const buyoutsOf = (familyQboId: string) => db.select().from(buyout).where(eq(buyout.familyQboId, familyQboId)).orderBy(buyout.createdAt);
/** The write queue's items for one buy-out, oldest first. */
export const queueOf = async (buyoutId: string) => (await db.select().from(writeQueue).orderBy(writeQueue.createdAt))
  .filter((r) => "buyoutId" in r.request && r.request.buyoutId === buyoutId);

export type FamilyBuyout = {
  /** The volunteer requirement asked of this family alone, with a buy-out, and the choice key of its page. */
  requirementId: string; key: string;
  /** Strings that belong to this family's buy-out alone: the requirement's title and id, the amount, the state's words, the buy-out's id. */
  markers: string[];
  /** What this family's parent must find on the Volunteer page. */
  page: string[];
};

/**
 * A volunteer requirement with a buy-out for family A and one for family B (tests/helpers/parent.ts), each asked of
 * that family alone and optional, in the season's last step, so no step's count changes: A has chosen its buy-out and
 * it is invoiced; B's is paid. Neither family's ids are digits, so nothing is ever asked of QuickBooks for them.
 */
export async function seedTwoFamilyBuyouts(a: { spec: ParentFamilySpec; parentId: string }, b: { spec: ParentFamilySpec; parentId: string }, season: SeededSeason): Promise<{ a: FamilyBuyout; b: FamilyBuyout }> {
  const stepId = Object.values(season.stepIds).at(-1)!;
  const A = { title: "Concession stand shifts QA74", unitCents: 3719, units: 2 }, B = { title: "Parking lot hours QB85", unitCents: 2147, units: 3 };
  const reqA = await seedBuyoutRequirement({ stepId, title: A.title, required: false, amount: A.units, unit: "shifts", unitCents: A.unitCents, chosen: [a.spec.family.qboId] });
  const reqB = await seedBuyoutRequirement({ stepId, title: B.title, required: false, amount: B.units, unit: "hours", unitCents: B.unitCents, chosen: [b.spec.family.qboId] });
  const forA = await seedBuyout({ requirementId: reqA, familyQboId: a.spec.family.qboId, chosenBy: a.parentId, state: "invoiced", unitCents: A.unitCents, units: A.units, invoiceQboId: "9174" });
  const forB = await seedBuyout({ requirementId: reqB, familyQboId: b.spec.family.qboId, chosenBy: b.parentId, state: "paid", unitCents: B.unitCents, units: B.units, invoiceQboId: "9285" });
  const amountA = formatMoney(A.unitCents * A.units), amountB = formatMoney(B.unitCents * B.units);
  return {
    a: { requirementId: reqA, key: "family", markers: [A.title, reqA, forA.id, amountA, "Buy-out invoiced"], page: [A.title, "Buy-out invoiced"] },
    b: { requirementId: reqB, key: "family", markers: [B.title, reqB, forB.id, amountB, "Paid instead"], page: [B.title, "Paid instead"] },
  };
}
