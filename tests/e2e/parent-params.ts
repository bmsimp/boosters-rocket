import type { DynamicRouteParams } from "./parent-routes";
import { E2E_VOLUNTEER } from "./volunteer-seed";
import { E2E_EMAIL } from "./email-seed";
import { E2E_BUYOUT } from "./buyout-seed";
import { E2E_MESSAGE } from "./messages-seed";

/**
 * For a page with a dynamic segment: the params to ask for it with, ids from scripts/seed-e2e.ts. `own` is something of
 * the Quetzalcoatl family (E2E-FAMILY), `other` the same kind of thing in another family.
 *   "/students/[id]": { own: { id: "E2E-S1" }, other: { id: "E2E-S3" } },
 */
export const PARAMS: Record<string, DynamicRouteParams> = {
  // A shift is the club's, not a family's: `own` is one the Quetzalcoatl family can sign up for, `other` the one the
  // Rivera family has a place on. Neither may send anything of the Riveras' but the count.
  "/volunteer/shifts/[id]": { own: { id: E2E_VOLUNTEER.cleanup }, other: { id: E2E_VOLUNTEER.griddle } },
  // A check-in code: `own` opens the shift Zelda has a place on, `other` the griddle, where only the Riveras have one.
  "/volunteer/check-in/[code]": { own: { code: E2E_VOLUNTEER.openCode }, other: { code: E2E_VOLUNTEER.griddleCode } },
  // The Quetzalcoatl family's signed Travel consent, and the second family's unsigned one (fixed ids in scripts/seed-e2e.ts).
  "/forms/[id]": { own: { id: "e2e00000-0000-4000-8000-000000000001" }, other: { id: "e2e00000-0000-4000-8000-000000000002" } },
  // Zelda's change of sign-in address asked under the Quetzalcoatl family, and the one asked under her second family.
  "/family/email/[token]": { own: { token: E2E_EMAIL.own.token }, other: { token: E2E_EMAIL.other.token } },
  // Paying instead: a requirement offered to the Quetzalcoatl family, and one asked of the Rivera family alone.
  "/volunteer/pay-instead/[requirementId]/[choice]": { own: { requirementId: E2E_BUYOUT.offered, choice: "family" }, other: { requirementId: E2E_BUYOUT.other, choice: "family" } },
  // A club message is the same for every family: `own` is the seeded one, `other` an id that is no message (404).
  "/messages/[id]": { own: { id: E2E_MESSAGE.id }, other: { id: "7c1d2f0e-5e2e-4000-8000-00000000e2ff" } },
  // Its poster's profile, and a staff id that posted nothing (404), so the club's staff can't be listed.
  "/messages/from/[staffId]": { own: { staffId: E2E_MESSAGE.posterId }, other: { staffId: "7c1d2f0e-5e2e-4000-8000-00000000e2af" } },
};
