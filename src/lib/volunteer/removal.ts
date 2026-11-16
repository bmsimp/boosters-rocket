// What stands in the way of removing a volunteer requirement (src/lib/seasons/setup.ts): places families hold on
// shifts that count toward it. Removing it would unlink every such shift at once, and nothing would say which.
import "server-only";
import { and, count, inArray, isNull, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";

/** How many live places, on shifts and events still on, count toward these requirements. */
export async function placesHolding(requirementIds: readonly string[], tx: Tx): Promise<number> {
  if (requirementIds.length === 0) return 0;
  const [n] = await tx.select({ n: count() }).from(volunteerShiftRequirement)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerShiftRequirement.shiftId))
    .innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .innerJoin(volunteerSignup, eq(volunteerSignup.shiftId, volunteerShift.id))
    .where(and(inArray(volunteerShiftRequirement.requirementId, [...requirementIds]), isNull(volunteerShift.cancelledAt), isNull(volunteerEvent.cancelledAt), isNull(volunteerSignup.cancelledAt)));
  return n?.n ?? 0;
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
  `${name} can't be removed: ${held === 1 ? "a volunteer place counts" : `${held} volunteer places count`} toward it on shifts still on. Make it optional so it no longer holds the step open, or keep it.`;
