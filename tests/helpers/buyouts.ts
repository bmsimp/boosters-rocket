// Volunteer buy-outs in tests (src/lib/buyouts/): a volunteer requirement that offers one, a buy-out row as the
// portal leaves it in each state, and a family whose ids are digits, connected through the QuickBooks stub, so its
// invoices are really made and voided there (tests/helpers/qbo-stub.ts).
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, requirement, requirementCover, season, seasonStep, writeQueue, type BuyoutState } from "@/lib/db/schema";
import { connectCompany, RIVERA } from "./money";
import { MONEY_REALM, seedSignedInParent, type ParentFamilySpec, type SeededParent } from "./parent";
import type { QboStub } from "./qbo-stub";

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
  if (o.chosen?.length) await db.insert(requirementCover).values(o.chosen.map((subjectQboId) => ({ requirementId: r!.id, subjectQboId })));
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
