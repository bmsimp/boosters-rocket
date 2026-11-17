// The worker's part in forms (v1 spec §9.2 step 5, as the verification changed it): Documenso's webhooks are not
// retried, so every few minutes the worker asks Documenso about each form that is out and not finished, and stores
// what the API says. A form every guardian has signed that still isn't sealed after a while has its sealing queued
// again (verification, 1a point 3: Documenso's own sweep stops after six hours).
import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { signatureRequest } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { distributeEnvelope } from "@/lib/documenso/client";
import { FORMS_WORKER, asking, readAndStore } from "./requests";
import { getFormsConfig, noteAsked } from "./settings";
import { UNFINISHED } from "./states";

export const FORMS_JOB = "forms.check";
/** A form is asked about again when it was last read this long ago. */
export const ASK_EVERY_MS = 5 * 60_000;
/** Signed by everyone this long ago and still not sealed: the portal asks Documenso to seal it again, and again after the same wait. */
export const SEAL_AGAIN_AFTER_MS = 20 * 60_000;
/** Signed by everyone this long ago and still not sealed: the Health page says so (verification, section 5 point 7). */
export const SEALING_LATE_MS = 60 * 60_000;
/** One wake asks about this many at most, the longest unread first, so a backlog can't hold the worker's minute. */
export const ASK_AT_MOST = 40;

export type FormsCheck = { asked: number; failed: number; completed: number; sealAsked: number };

/** One pass: nothing when forms aren't set up. One form's failure never stops the pass for good: the next wake tries it again. */
export async function checkOpenForms(now: Date = new Date()): Promise<FormsCheck> {
  const done: FormsCheck = { asked: 0, failed: 0, completed: 0, sealAsked: 0 };
  const config = await getFormsConfig();
  if (!config) return done;
  const due = await db.select().from(signatureRequest)
    .where(and(inArray(signatureRequest.state, [...UNFINISHED]), isNotNull(signatureRequest.envelopeId),
      or(isNull(signatureRequest.checkedAt), lt(signatureRequest.checkedAt, new Date(now.getTime() - ASK_EVERY_MS)))))
    .orderBy(sql`${signatureRequest.checkedAt} asc nulls first`, asc(signatureRequest.id)).limit(ASK_AT_MOST);
  for (const row of due) {
    const read = await readAndStore(row, config, { actor: FORMS_WORKER, ip: null });
    done.asked++;
    if (!read.ok) {
      done.failed++;
      // Documenso can't be reached, or refuses the token: the rest would fail the same way, and the next wake is a minute off.
      if (read.code === "unreachable" || read.code === "timeout" || read.code === "unauthorized") break;
      continue;
    }
    const after = read.row;
    if (after.state === "complete") done.completed++;
    if (after.state !== "signed" || after.envelopeId === null || after.allSignedAt === null) continue;
    const waited = now.getTime() - Math.max(after.allSignedAt.getTime(), after.sealAskedAt?.getTime() ?? 0);
    if (waited < SEAL_AGAIN_AFTER_MS) continue;
    // On a document every recipient has signed, `distribute` sends nothing: it queues the sealing again.
    const asked = await asking(() => distributeEnvelope(config, after.envelopeId!));
    await db.transaction(async (tx) => {
      await tx.update(signatureRequest).set({ sealAskedAt: now, updatedAt: new Date() }).where(and(eq(signatureRequest.id, after.id), eq(signatureRequest.envelopeId, after.envelopeId!)));
      await writeAudit({ actor: FORMS_WORKER, action: "form.seal.ask", targetType: "signature_request", targetId: after.id,
        after: { envelopeId: after.envelopeId, signedAt: after.allSignedAt!.toISOString(), accepted: asked.ok, ...(asked.ok ? {} : { code: asked.code }) } }, tx);
    });
    if (asked.ok) done.sealAsked++; else done.failed++;
  }
  if (done.asked > 0) await noteAsked();
  return done;
}

/** For the Health page: forms out and not finished, and those every guardian signed more than an hour ago that still aren't sealed. */
export async function formsWaiting(now: Date = new Date()): Promise<{ open: number; sealingLate: number }> {
  const rows = await db.select({ state: signatureRequest.state, allSignedAt: signatureRequest.allSignedAt }).from(signatureRequest).where(inArray(signatureRequest.state, [...UNFINISHED]));
  return { open: rows.length, sealingLate: rows.filter((r) => r.state === "signed" && r.allSignedAt !== null && now.getTime() - r.allSignedAt.getTime() > SEALING_LATE_MS).length };
}
