// Which kept signed-form evidence is the current company's, for the parent's download and the staff Forms pages alike.
// It narrows, and finds nothing by itself: every reader matches evidence by its request (and a parent's also by the app
// family it names), never by a QuickBooks id. Parent code imports it (src/lib/forms is scanned whole as parent-facing).
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { signedFormEvidence } from "@/lib/db/schema";

/**
 * Evidence that is not marked as an earlier company's, and was kept either in the company the roster names or with no
 * company at all (its family had no QuickBooks link then, or the roster named no company: a family the club keeps by
 * hand signs forms like any other). Never a company other than the roster's.
 */
export function currentEvidence(rosterRealmId: string | null): SQL {
  const company = rosterRealmId === null ? isNull(signedFormEvidence.realmId) : or(isNull(signedFormEvidence.realmId), eq(signedFormEvidence.realmId, rosterRealmId))!;
  return and(isNull(signedFormEvidence.earlierCompanyAt), company)!;
}

/** The same rule, for a row already read. */
export function isCurrentEvidence(e: { earlierCompanyAt: Date | null; realmId: string | null }, rosterRealmId: string | null): boolean {
  return e.earlierCompanyAt === null && (e.realmId === null || e.realmId === rosterRealmId);
}
