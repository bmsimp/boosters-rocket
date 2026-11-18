// Privacy: a family's own signed forms, for the parent download (src/app/(parent)/forms/[id]/signed/route.ts) and the
// pages that offer it. The family is the session's (ctx.familyQboId, turned once into the app's own active family by
// activeFamilyOf()) and nothing else. A request id from the address is looked up within that family (requestOfFamily),
// and its evidence by that request, by the app family it names now and by the QuickBooks company the roster cache
// holds: evidence kept from an earlier company names no app family (signed_form_evidence_app_records), and is never
// matched to a family by its QuickBooks ids, which may name another family there. It never imports the staff-only modules: tests/integration/page-guards.test.ts
// scans this folder. A form whose student moved here from another family is downloaded only when every guardian on
// it is this family's own (signedWithin()): its PDF holds the signing family's names, signatures and filled-in fields.
import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { signatureRequest, signedFormEvidence, signedFormFile } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { getRosterSource } from "@/lib/roster/source";
import { isUuid } from "@/lib/seasons/ids";
import type { AppFamilyId } from "@/lib/families/ids";
import { activeFamilyOf } from "@/lib/families/session-family";
import { requestOfFamily, signedWithin } from "./requests";

/** The kept evidence of these requests of the family, as the company now connected holds them, signed within the family. */
async function evidenceOf(familyId: AppFamilyId, requestIds: readonly string[]): Promise<{ id: string; requestId: string }[]> {
  if (requestIds.length === 0) return [];
  const requests = await db.select({ id: signatureRequest.id, signers: signatureRequest.signers }).from(signatureRequest)
    .where(and(inArray(signatureRequest.id, [...requestIds]), eq(signatureRequest.familyId, familyId)));
  const ours: string[] = [];
  for (const r of requests) if (await signedWithin(familyId, r.signers)) ours.push(r.id);
  if (ours.length === 0) return [];
  const realmId = await getRosterSource();
  if (realmId === null) return [];
  const rows = await db.select({ id: signedFormEvidence.id, requestId: signedFormEvidence.requestId }).from(signedFormEvidence)
    .where(and(inArray(signedFormEvidence.requestId, ours), eq(signedFormEvidence.familyId, familyId), eq(signedFormEvidence.realmId, realmId),
      isNull(signedFormEvidence.earlierCompanyAt)));
  return rows.filter((r): r is { id: string; requestId: string } => r.requestId !== null);
}

/** Which of these requests of the signed-in family have a signed form to download, and how many parts each has. */
export async function mySignedDownloads(ctx: ParentCtx, requestIds: readonly string[]): Promise<Map<string, number>> {
  const familyId = await activeFamilyOf(ctx.familyQboId);
  if (familyId === null) return new Map();
  const found = await evidenceOf(familyId, requestIds.filter(isUuid));
  if (found.length === 0) return new Map();
  const files = await db.select({ evidenceId: signedFormFile.evidenceId }).from(signedFormFile)
    .where(and(inArray(signedFormFile.evidenceId, found.map((f) => f.id)), eq(signedFormFile.kind, "sealed_pdf")));
  const parts = new Map<string, number>();
  for (const f of found) parts.set(f.requestId, files.filter((x) => x.evidenceId === f.id).length);
  return parts;
}

/**
 * The sealed PDF of one of the signed-in family's own forms: part `part` (1 unless the document had several). Null for
 * anything else, whatever the reason (an id that isn't a uuid, nobody's, another family's, a form not signed, one
 * signed by another family's guardians before its student moved here, one whose evidence isn't kept yet or is an
 * earlier company's): the caller answers 404 in the same way for all of them.
 */
export async function findMySignedPdf(ctx: ParentCtx, requestId: unknown, part: unknown = 1): Promise<Buffer | null> {
  if (!isUuid(requestId)) return null;
  const position = typeof part === "number" ? part : typeof part === "string" && /^[1-9][0-9]?$/.test(part) ? Number(part) : NaN;
  if (!Number.isInteger(position) || position < 1 || position > 99) return null;
  const familyId = await activeFamilyOf(ctx.familyQboId);
  if (familyId === null) return null;
  const row = await requestOfFamily(requestId, familyId);
  if (!row || row.state !== "complete") return null;
  const [evidence] = await evidenceOf(familyId, [row.id]);
  if (!evidence) return null;
  const [file] = await db.select({ bytes: signedFormFile.bytes }).from(signedFormFile)
    .where(and(eq(signedFormFile.evidenceId, evidence.id), eq(signedFormFile.kind, "sealed_pdf"), eq(signedFormFile.position, position))).orderBy(asc(signedFormFile.position)).limit(1);
  return file?.bytes ?? null;
}
