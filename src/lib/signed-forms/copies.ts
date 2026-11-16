// Staff only (it reads the kept forms of every family): the copy of a signed form each guardian who signed it is
// emailed, once, after its evidence is kept (v1 spec §9.2 step 6). Never imported by parent code (STAFF_ONLY_IMPORTS
// in tests/integration/page-guards.test.ts).
import "server-only";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db/client";
import { guardian, parent, signedFormCopy, signedFormEvidence, signedFormFile } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { FORMS_WORKER, signedWithin } from "@/lib/forms/requests";
import { signedFormCopyMessage } from "@/lib/mail/messages";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { getStoredMailConfig } from "@/lib/mail/settings";
import { ATTACH_LIMIT_BYTES } from "./rules";

/** The kept forms whose copies one wake deals with, at most. */
export const COPIES_PER_WAKE = 10;

/** Where a guardian downloads their family's signed form, signed in: the parent download (src/app/(parent)/forms/[id]/signed). */
export const parentDownloadLink = (requestId: string): string => `${env.APP_URL.replace(/\/+$/, "")}/forms/${requestId}/signed`;

export type CopyCounts = { sent: number; failed: number; skipped: number };

/**
 * The copies owed for evidence already kept: to each guardian recorded as a signer on the request, and to nobody
 * else. A guardian who is blocked, or whose link to the family is closed by then, gets nothing (one whose student
 * moved to another family before the evidence was kept is reached through their link to the family they signed in). Each send is claimed
 * first, in one statement (signed_form_copy), so two wakes can never send one twice, and it is never tried again
 * after a failure. Nothing goes while outgoing mail isn't set up: the copies wait for it. Evidence of an earlier
 * QuickBooks company sends nothing.
 */
export async function sendOwedCopies(): Promise<CopyCounts> {
  const counts: CopyCounts = { sent: 0, failed: 0, skipped: 0 };
  if (!(await getStoredMailConfig())) return counts;
  const owed = await db.select().from(signedFormEvidence).where(and(isNull(signedFormEvidence.copiesDoneAt), isNull(signedFormEvidence.earlierCompanyAt)))
    .orderBy(asc(signedFormEvidence.storedAt)).limit(COPIES_PER_WAKE);
  for (const evidence of owed) {
    if (evidence.requestId === null) continue;
    const sealed = await db.select({ size: signedFormFile.size }).from(signedFormFile).where(and(eq(signedFormFile.evidenceId, evidence.id), eq(signedFormFile.kind, "sealed_pdf")));
    // One item small enough to attach goes with the email; a larger one, or several, is a link to the signed-in download.
    const attach = sealed.length === 1 && sealed[0]!.size < ATTACH_LIMIT_BYTES;
    const pdf = attach ? (await db.select({ bytes: signedFormFile.bytes }).from(signedFormFile)
      .where(and(eq(signedFormFile.evidenceId, evidence.id), eq(signedFormFile.kind, "sealed_pdf"))))[0]!.bytes : null;
    const signers = [...new Set(evidence.signers.filter((s) => s.parentId && s.signedAt).map((s) => s.parentId!))];
    for (const parentId of signers) {
      // The claim, in one statement: only the call that makes the row sends.
      const claimed = await db.insert(signedFormCopy).values({ evidenceId: evidence.id, parentId }).onConflictDoNothing().returning({ id: signedFormCopy.id });
      if (claimed.length === 0) continue;
      const done = (outcome: "sent" | "failed" | "skipped", how: "attached" | "link" | null) =>
        db.update(signedFormCopy).set({ outcome, how, doneAt: new Date() }).where(eq(signedFormCopy.id, claimed[0]!.id));
      const audit = { targetType: "signed_form_evidence", targetId: evidence.id };
      // Their open link to the family the form is kept under, or, when its student moved to another family before the
      // evidence was kept (formsForMovedStudent), to the family they signed it in: the one every signer is a guardian
      // of. The download link is the new family's, so a moved form whose PDF can't go with the email is skipped.
      const links = await db.select({ email: parent.email, familyQboId: guardian.familyQboId }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
        .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"), eq(parent.blocked, false)));
      let to = links.find((l) => l.familyQboId === evidence.familyQboId);
      if (!to && pdf) for (const l of links) if (await signedWithin(l.familyQboId, evidence.signers.map((x) => ({ parentId: x.parentId ?? "" })))) { to = l; break; }
      if (!to) {
        await done("skipped", null);
        await writeAudit({ actor: FORMS_WORKER, action: "forms.copy.skipped", ...audit, after: { parentId, requestId: evidence.requestId, reason: "no_open_link" } });
        counts.skipped++;
        continue;
      }
      const forName = evidence.subjectName ?? evidence.familyName ?? "your family";
      const message = signedFormCopyMessage(await currentBrand(), to.email, { formTitle: evidence.formTitle, forName, pdf, link: parentDownloadLink(evidence.requestId) });
      const sent = await sendMail(message, { purpose: "form_copy", actor: FORMS_WORKER });
      const how = pdf ? "attached" : "link";
      await done(sent.ok ? "sent" : "failed", how);
      await writeAudit({ actor: FORMS_WORKER, action: sent.ok ? "forms.copy.sent" : "forms.copy.failed", ...audit,
        after: { parentId, requestId: evidence.requestId, how, ...(sent.ok ? {} : { error: sent.error }) } });
      if (sent.ok) counts.sent++; else counts.failed++;
    }
    await db.update(signedFormEvidence).set({ copiesDoneAt: new Date() }).where(eq(signedFormEvidence.id, evidence.id));
  }
  return counts;
}
