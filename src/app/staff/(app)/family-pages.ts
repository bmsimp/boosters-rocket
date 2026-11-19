import type { AppFamilyId } from "@/lib/families/ids";

/**
 * The addresses of the staff pages about one family, each by the app's own family id (stage 3 of the app-owned
 * families spec): the one place they are built, so a link can't be made from a QuickBooks id. Each page checks the id
 * itself (familyRecordAt(), src/lib/families/address.ts) and answers Not found for anything else.
 */
const at = (id: AppFamilyId) => encodeURIComponent(String(id));

/** The family's roster page. */
export const familyPage = (id: AppFamilyId) => `/staff/roster/${at(id)}`;
/** The family's volunteer buy-outs. */
export const familyBuyoutsPage = (id: AppFamilyId) => `/staff/roster/${at(id)}/buyouts`;
/** What the family owes. */
export const familyBalancePage = (id: AppFamilyId) => `/staff/balances/${at(id)}`;
/** Where the family stands in a season: the current one, or the one named. */
export const familyProgressPage = (id: AppFamilyId, seasonId?: string) =>
  `/staff/seasons/progress/family/${at(id)}${seasonId === undefined ? "" : `?season=${encodeURIComponent(seasonId)}`}`;
/** The family's volunteer credit. */
export const familyCreditPage = (id: AppFamilyId) => `/staff/volunteer/credit/${at(id)}`;
