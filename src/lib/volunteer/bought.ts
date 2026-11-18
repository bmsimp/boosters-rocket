// A boundary of stage 2 of the app-owned families spec (AGENTS.md, Seasons): volunteering keeps its records by the
// app's own families and students, and buy-outs are still kept by QuickBooks customer (src/lib/buyouts/). The volunteer
// rule (src/lib/seasons/kinds.ts) and the spending of credit (./credit.ts) read whether a requirement's buy-out stands
// through here: the records asked about go as the customers their links name (of the kind the requirement asks for), in
// the records' company, and each answer comes back to the record. It goes when buy-outs move to the app's ids. It reads
// only the families and students it is asked about (or every buy-out, for staff, turned back through those buy-outs'
// own customers), so parent code may import it (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts).
import "server-only";
import type { Tx } from "@/lib/db/client";
import { linksOf, linksOfCustomers, type LinkMaps } from "@/lib/families/links";
import { buyoutFacts } from "@/lib/buyouts/standing";
import type { BuyoutFact } from "@/lib/buyouts/rules";
import type { RequirementFields, SubjectId, SubjectsAsked } from "@/lib/seasons/progress";

/**
 * The live buy-outs of these requirements, for these families and students (`asked`; null is everyone, for staff),
 * keyed by `key(requirementId, record)`. A buy-out whose customer has no record of the requirement's kind in the
 * records' company is left out, as having nothing to show.
 */
export async function buyoutsByRecord(requirements: readonly Pick<RequirementFields, "id" | "appliesTo">[], asked: SubjectsAsked | null,
  key: (requirementId: string, subject: SubjectId) => string, tx?: Tx): Promise<Map<string, BuyoutFact>> {
  const out = new Map<string, BuyoutFact>();
  if (requirements.length === 0 || (asked && asked.families.length === 0 && asked.students.length === 0)) return out;
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const ids = requirements.map((r) => r.id);
  const split = (k: string) => { const at = k.indexOf("|"); return { requirement: byId.get(k.slice(0, at)), customerId: k.slice(at + 1) }; };
  let links: LinkMaps, facts: Map<string, BuyoutFact>;
  if (asked) {
    links = await linksOf(asked, tx);
    facts = await buyoutFacts(ids, [...links.customerOfFamily.values(), ...links.customerOfStudent.values()], tx);
  } else {
    facts = await buyoutFacts(ids, null, tx);
    const families: string[] = [], students: string[] = [];
    for (const k of facts.keys()) {
      const { requirement, customerId } = split(k);
      if (requirement) (requirement.appliesTo === "family" ? families : students).push(customerId);
    }
    links = await linksOfCustomers({ families, students }, tx);
  }
  for (const [k, fact] of facts) {
    const { requirement, customerId } = split(k);
    if (!requirement) continue;
    const record = requirement.appliesTo === "family" ? links.familyOfCustomer.get(customerId) : links.studentOfCustomer.get(customerId);
    if (record !== undefined) out.set(key(requirement.id, record), fact);
  }
  return out;
}
