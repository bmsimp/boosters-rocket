import { accountingOn } from "@/plugins";
import type { Slots } from "@/plugins/types";
import { addFamilyByHand, addStudentByHand } from "./by-hand";

/**
 * How a new family or student is made (the slot `families.howToAdd`, docs/superpowers/specs/2026-11-28-accounting-plugin-design.md,
 * section 3): the accounting plugin's way while one is on, its books first as today; otherwise the core's own, saved
 * at once by hand with nothing sent (src/lib/families/by-hand.ts).
 */
export const BY_HAND: Slots["families.howToAdd"] = {
  family: (ask, _rosterTag, o) => addFamilyByHand(ask, o),
  student: (familyId, name, _rosterTag, o) => addStudentByHand(familyId, name, o),
};

export async function howToAdd(): Promise<Slots["families.howToAdd"]> {
  return (await accountingOn())?.slots["families.howToAdd"] ?? BY_HAND;
}
