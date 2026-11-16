// Staff only: starting a form that isn't complete again (v1 spec §9.2, verification 1a "Rejection is a state" and
// section 6 "Withdrawing a document"). Its document is withdrawn (deleted while nobody has signed it, cancelled once
// someone has; a completed one is never touched), and the request goes back to not opened, so the next open makes a
// new document. The reason is kept for staff, in the audit row; the parent reads only that the form is ready to sign.
import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { signatureRequest } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { cancelEnvelope, deleteEnvelope } from "@/lib/documenso/client";
import { NO_DOCUMENT, asking, claim, readAndStore, release } from "@/lib/forms/requests";
import { getFormsConfig } from "@/lib/forms/settings";
import { isUuid } from "@/lib/seasons/ids";
import { RESTART_REASONS, restartPlan, type RestartReason } from "./rules";

type Op = { actor: Actor; ip: string | null; permission?: string };
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
export const NOTE_MAX = 500;
const GONE = "That form isn't there any more. Reload the page.";

export async function startRequestAgain(requestId: unknown, reason: unknown, rawNote: unknown, op: Op, now: Date = new Date()): Promise<Done> {
  if (!isUuid(requestId)) return { ok: false, errors: [GONE] };
  if (typeof reason !== "string" || !Object.hasOwn(RESTART_REASONS, reason)) return { ok: false, errors: ["Choose why it is being started again."] };
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (note.length > NOTE_MAX) return { ok: false, errors: [`Keep the note under ${NOTE_MAX} characters.`] };
  const [stored] = await db.select().from(signatureRequest).where(eq(signatureRequest.id, requestId));
  if (!stored) return { ok: false, errors: [GONE] };
  const first = restartPlan(stored, reason as RestartReason, now);
  if (!first.ok) return { ok: false, errors: [first.why] };
  const config = await getFormsConfig();
  if (!config) return { ok: false, errors: ["Forms aren't set up, so the document in Documenso can't be withdrawn. An Admin can connect Documenso under Forms settings."] };
  // What Documenso says now, not what the portal last stored: a guardian may have signed, or the form been sealed,
  // since the last read. A form found complete is stored as such (its evidence is then owed) and never withdrawn.
  // Read before the claim: a held request is left alone by every reader, this one included.
  const read = await readAndStore(stored, config, { actor: op.actor, ip: op.ip });
  if (!read.ok && read.code !== "not_found") return { ok: false, errors: ["Documenso couldn't be reached just now, so nothing was changed. Please try again in a few minutes."] };
  const row = read.row;
  const plan = restartPlan(row, reason as RestartReason, now);
  if (!plan.ok) return { ok: false, errors: [plan.why] };
  // Held while the document is withdrawn: no parent's open can make or read it in the meantime.
  if (!(await claim(row.id, now))) return { ok: false, errors: ["Someone is opening this form right now. Try again in a minute."] };
  try {
    const envelopeId = row.envelopeId!;
    const withdrawn = await asking(() => (plan.withdraw === "cancel" ? cancelEnvelope(config, envelopeId, "Started again by the club") : deleteEnvelope(config, envelopeId)));
    // Already gone from Documenso is what "gone" means; anything else leaves the request as it was.
    if (!withdrawn.ok && withdrawn.code !== "not_found") return { ok: false, errors: ["Documenso couldn't withdraw the document just now, so nothing was changed. Please try again in a few minutes."] };
    const done = await db.transaction(async (tx) => {
      const cleared = await tx.update(signatureRequest).set({ ...NO_DOCUMENT, evidenceOwed: false, evidenceTries: 0, evidenceError: null, evidenceNextAt: null, updatedAt: new Date() })
        .where(and(eq(signatureRequest.id, row.id), eq(signatureRequest.envelopeId, envelopeId), ne(signatureRequest.state, "complete"))).returning({ id: signatureRequest.id });
      if (cleared.length === 0) return false;
      await writeAudit({ actor: op.actor, action: "forms.request.restart", permission: op.permission, targetType: "signature_request", targetId: row.id, ip: op.ip,
        before: { state: row.state, envelopeId, documensoStatus: row.envelopeStatus, signers: row.signers.map((s) => ({ parentId: s.parentId || null, name: s.name, signedAt: s.signedAt })),
          allSignedAt: row.allSignedAt?.toISOString() ?? null, familyQboId: row.familyQboId, subjectQboId: row.subjectQboId },
        after: { state: "not_opened", reason, note: note || null, withdrawn: withdrawn.ok ? plan.withdraw : "already_gone" } }, tx);
      return true;
    });
    return done ? { ok: true, message: "Started again. The family can sign it from their Forms page; the next open makes a new document." }
      : { ok: false, errors: ["This form changed while it was being started again. Reload the page to see where it stands."] };
  } finally {
    await release(row.id);
  }
}
