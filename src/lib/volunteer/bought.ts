// Whether a requirement's buy-out stands, as volunteering reads it: the volunteer rule (src/lib/seasons/kinds.ts) and
// the spending of credit (./credit.ts) ask here by the app's own families and students, as buy-outs keep them (stage 2
// of the app-owned families spec), and the answer is keyed as the caller keys its own (pairKey or slotKey). It reads
// only the families and students it is asked about (or every buy-out, for staff), so parent code may import it
// (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts).
import "server-only";
import type { Tx } from "@/lib/db/client";
import { buyoutFacts } from "@/lib/buyouts/standing";
import type { BuyoutFact } from "@/lib/buyouts/rules";
import type { RequirementFields, SubjectId, SubjectsAsked } from "@/lib/seasons/progress";

/**
 * The live buy-outs of these requirements, for these families and students (`asked`; null is everyone, for staff),
 * keyed by `key(requirementId, record)`.
 */
export async function buyoutsByRecord(requirements: readonly Pick<RequirementFields, "id">[], asked: SubjectsAsked | null,
  key: (requirementId: string, subject: SubjectId) => string, tx?: Tx): Promise<Map<string, BuyoutFact>> {
  return buyoutFacts(requirements.map((r) => r.id), asked, key, tx);
}
