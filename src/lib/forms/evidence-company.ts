// Which kept signed-form evidence is current, for the parent's download and the staff Forms pages alike. It narrows,
// and finds nothing by itself: every reader matches evidence by its request (and a parent's also by the app family it
// names), never by a QuickBooks id. Parent code imports it (src/lib/forms is scanned whole as parent-facing).
import { isNull, type SQL } from "drizzle-orm";
import { signedFormEvidence } from "@/lib/db/schema";

/**
 * Evidence not marked as an earlier company's (`earlier_company_at` null), whatever company copy it holds (stage 4's
 * slice M7a). Its `realm_id` and its QuickBooks copies stay as signed and decide nothing: a family kept across a change
 * of company is still the family whose form it is, found by its request and the app family the row names. Evidence
 * archived before that slice (a change of company then marked it and cut it from its request and family) stays
 * archived: it names no app record (signed_form_evidence_app_records) and is matched to nobody.
 */
export function currentEvidence(): SQL {
  return isNull(signedFormEvidence.earlierCompanyAt);
}

/** The same rule, for a row already read. */
export function isCurrentEvidence(e: { earlierCompanyAt: Date | null }): boolean {
  return e.earlierCompanyAt === null;
}
