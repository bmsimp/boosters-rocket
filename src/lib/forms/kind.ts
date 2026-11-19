// How a form requirement is met (v1 spec §10.2): its Documenso document is complete, which is the request's state
// "complete" and nothing short of it. The entry src/lib/seasons/kinds.ts gives the form kind. Requests name the app's
// own family and student (stage 2 of the app-owned families spec), so the rule is asked by the app's ids, as the season
// keeps them, and answers by pairKey(). It reads the requests of the requirements and the families and students it is
// asked about, and no others: a parent's season passes its own family and students. Imports no staff-only module
// (tests/integration/page-guards.test.ts scans this folder).
import "server-only";
import { and, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, signatureRequest } from "@/lib/db/schema";
import type { AppKindRule } from "@/lib/seasons/kinds";
import type { Standing } from "@/lib/seasons/progress";
import { getFormsConfig } from "./settings";
import { subjectOfRequest } from "./requests";
import { STATE_WORDS, isMet, wordsFor } from "./states";

// pairKey() of src/lib/seasons/kinds.ts, written here too: that module imports this one, so it can't be imported back
// at run time. The two are the same text: `<requirement>|<subject's app id>`.
const key = (requirementId: string, subject: unknown) => `${requirementId}|${String(subject)}`;

export const formRule: AppKindRule = {
  standings: async ({ requirements, asked, viewing }) => {
    const standings = new Map<string, Standing>();
    const ids = requirements.map((r) => r.id);
    if (ids.length === 0 || (asked && asked.families.length === 0)) return standings;
    // Asked about one family, only that family's own requests: a student who moved in brings no other family's
    // signatures along. A per-family form's subject is the family itself; a per-student one's is its student.
    const rows = await db.select({ requirementId: signatureRequest.requirementId, familyId: signatureRequest.familyId, studentId: signatureRequest.studentId,
      state: signatureRequest.state, signers: signatureRequest.signers })
      .from(signatureRequest).where(and(inArray(signatureRequest.requirementId, ids), asked ? and(inArray(signatureRequest.familyId, [...asked.families]),
        or(isNull(signatureRequest.studentId), ...(asked.students.length ? [inArray(signatureRequest.studentId, [...asked.students])] : []))) : undefined));
    // Asked about particular families or students (a parent's own season, or staff looking at one family): a form
    // that can't be signed yet says so, in place of asking for a signature nobody can give.
    if (asked) {
      const [config, settings] = await Promise.all([getFormsConfig(), db.select({ id: requirement.id, form: requirement.form }).from(requirement).where(inArray(requirement.id, ids))]);
      for (const r of requirements) {
        if (config && settings.find((s) => s.id === r.id)?.form) continue;
        for (const subject of r.appliesTo === "family" ? asked.families : asked.students) standings.set(key(r.id, subject), { met: false, words: STATE_WORDS.notReady });
      }
    }
    for (const row of rows) {
      const at = key(row.requirementId, subjectOfRequest(row));
      // A form with nothing made for it keeps the words above; anything a document has reached is said as it is.
      if (row.state === "not_opened" && standings.has(at)) continue;
      standings.set(at, { met: isMet(row.state), words: wordsFor(row.state, row.signers, viewing.parentId) });
    }
    return standings;
  },
  nothingYet: () => ({ met: false, words: STATE_WORDS.notSigned }),
  ticked: false,
};
