// What stands in the way of removing a volunteer requirement (src/lib/seasons/setup.ts): places families hold on
// shifts that count toward it, credit counting toward it, and buy-outs chosen for it. Removing it would unlink every such shift at once, and
// nothing would say which; credit done outside the portal for it would go with it.
import "server-only";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { buyout, volunteerCredit, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";

/**
 * How many live places, on shifts and events still on, and live credits count toward these requirements: a place not
 * checked in yet, a check-in on a shift linked to one of them (cancelled or not: credit earned stays), and credit for
 * volunteering done outside the portal toward one of them.
 */
export async function placesHolding(requirementIds: readonly string[], tx: Tx): Promise<number> {
  if (requirementIds.length === 0) return 0;
  const ids = [...requirementIds];
  const [places] = await tx.select({ n: count() }).from(volunteerShiftRequirement)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerShiftRequirement.shiftId))
    .innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .innerJoin(volunteerSignup, eq(volunteerSignup.shiftId, volunteerShift.id))
    .leftJoin(volunteerCredit, and(eq(volunteerCredit.signupId, volunteerSignup.id), isNull(volunteerCredit.removedAt)))
    .where(and(inArray(volunteerShiftRequirement.requirementId, ids), isNull(volunteerShift.cancelledAt), isNull(volunteerEvent.cancelledAt), isNull(volunteerSignup.cancelledAt), isNull(volunteerCredit.id)));
  const [checkIns] = await tx.select({ n: count() }).from(volunteerShiftRequirement)
    .innerJoin(volunteerSignup, eq(volunteerSignup.shiftId, volunteerShiftRequirement.shiftId))
    .innerJoin(volunteerCredit, and(eq(volunteerCredit.signupId, volunteerSignup.id), isNull(volunteerCredit.removedAt)))
    .where(inArray(volunteerShiftRequirement.requirementId, ids));
  const [outside] = await tx.select({ n: count() }).from(volunteerCredit).where(and(inArray(volunteerCredit.requirementId, ids), isNull(volunteerCredit.removedAt)));
  // A buy-out of any state: it is a family's record of an invoice, and keeps the requirement it was for.
  const [bought] = await tx.select({ n: count() }).from(buyout).where(inArray(buyout.requirementId, ids));
  return (places?.n ?? 0) + (checkIns?.n ?? 0) + (outside?.n ?? 0) + (bought?.n ?? 0);
}

/** The shifts linked to these requirements, by requirement id: kept in the removal's audit row, so the links can be made again. */
export async function linkedShifts(requirementIds: readonly string[], tx: Tx): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (requirementIds.length === 0) return out;
  const rows = await tx.select().from(volunteerShiftRequirement).where(inArray(volunteerShiftRequirement.requirementId, [...requirementIds]));
  for (const r of rows) out.set(r.requirementId, [...(out.get(r.requirementId) ?? []), r.shiftId].sort());
  return out;
}

/** The refusal staff read, for a step or a requirement by name. */
export const placesHoldingWords = (name: string, held: number): string =>
  `${name} can't be removed: ${held === 1 ? "a volunteer place or credit counts" : `${held} volunteer places or credits count`} toward it. Make it optional so it no longer holds the step open, or keep it.`;
