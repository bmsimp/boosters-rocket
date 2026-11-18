// How a form requirement is met (v1 spec §10.2): its Documenso document is complete, which is the request's state
// "complete" and nothing short of it. The entry src/lib/seasons/kinds.ts gives the form kind. It reads the requests
// of the requirements and the families or students it is asked about, and no others: a parent's season passes its own
// family and students. Imports no staff-only module (tests/integration/page-guards.test.ts scans this folder).
import "server-only";
import { and, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, signatureRequest } from "@/lib/db/schema";
import type { CustomerKindRule } from "@/lib/seasons/kinds";
import type { Standing } from "@/lib/seasons/progress";
import { customerPairKey } from "@/lib/seasons/customer-keys";
import { getFormsConfig } from "./settings";
import { STATE_WORDS, isMet, wordsFor } from "./states";

// The kind rules answer by customer until forms move to the app's ids (src/lib/seasons/customer-keys.ts).
const key = customerPairKey;

export const formRule: CustomerKindRule = {
  standings: async ({ requirements, subjectQboIds, viewing }) => {
    const standings = new Map<string, Standing>();
    const ids = requirements.map((r) => r.id);
    if (ids.length === 0 || subjectQboIds?.length === 0) return standings;
    const rows = await db.select({ requirementId: signatureRequest.requirementId, subjectQboId: signatureRequest.subjectQboId, state: signatureRequest.state, signers: signatureRequest.signers })
      // Asked about one family, only that family's own requests: a student who moved in brings no other family's signatures along.
      .from(signatureRequest).where(and(inArray(signatureRequest.requirementId, ids),
        subjectQboIds ? and(inArray(signatureRequest.subjectQboId, [...subjectQboIds]), inArray(signatureRequest.familyQboId, [...subjectQboIds])) : undefined));
    // Asked about particular families or students (a parent's own season, or staff looking at one family): a form
    // that can't be signed yet says so, in place of asking for a signature nobody can give.
    if (subjectQboIds) {
      const [config, settings] = await Promise.all([getFormsConfig(), db.select({ id: requirement.id, form: requirement.form }).from(requirement).where(inArray(requirement.id, ids))]);
      for (const r of requirements) {
        if (config && settings.find((s) => s.id === r.id)?.form) continue;
        for (const subject of subjectQboIds) standings.set(key(r.id, subject), { met: false, words: STATE_WORDS.notReady });
      }
    }
    for (const row of rows) {
      // A form with nothing made for it keeps the words above; anything a document has reached is said as it is.
      if (row.state === "not_opened" && standings.has(key(row.requirementId, row.subjectQboId))) continue;
      standings.set(key(row.requirementId, row.subjectQboId), { met: isMet(row.state), words: wordsFor(row.state, row.signers, viewing.parentId) });
    }
    return standings;
  },
  nothingYet: () => ({ met: false, words: STATE_WORDS.notSigned }),
  ticked: false,
};
