// A guardian opens a form, agrees to sign electronically, and signs it in Documenso's frame (v1 spec §9.2; the calls
// are the recipe in docs/superpowers/specs/2026-11-15-documenso-verification.md, section 6).
//
// Privacy: every function here takes the session's ParentCtx and a form found by findMyForm(ctx, id), which looks the
// id up within the session's family. The signing token is read from Documenso each time, never stored, and handed
// only to the signed-in guardian whose recipient it is, after their consent (v1 spec §12, invariant 5). It imports no
// staff-only module: tests/integration/page-guards.test.ts scans this folder.
import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { formWithdrawal, guardian, parent, signatureRequest, type FormSetting, type RequestSigner } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { AppFamilyId } from "@/lib/families/ids";
import { writeAudit } from "@/lib/audit/log";
import { parentActor } from "@/lib/parents/sessions";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { getClubSettings } from "@/lib/settings/club";
import {
  EMAILS_OFF, PAGE_TIMEOUT_MS, deleteEnvelope, deleteRecipient, distributeEnvelope, findDocumentsByExternalId, getEnvelope, signingFrameUrl, documentFromTemplate,
  type DocumensoConfig, type Envelope, type EnvelopeRecipient,
} from "@/lib/documenso/client";
import { hasConsent, recordConsent } from "./consent";
import { findMyForm, type MyForm } from "./my-forms";
import { NO_DOCUMENT, asking, claim, holdsSignature, isHeld, readAndStore, release, requestRecords, signedWithin, whenReleased, type RequestRow } from "./requests";
import { getFormsConfig } from "./settings";
import { readDocument, signersFor, stillRight, wordsFor, type SignerIdentity } from "./states";
import { checkTemplate, type TemplatePlan } from "./template";

const PAGE = { timeoutMs: PAGE_TIMEOUT_MS };
export const DATE_FORMAT = "MM/dd/yyyy";
const TITLE_MAX = 200;

/** What the form page shows, beyond the form's name and who it is for. */
export type FormStep =
  /** The club hasn't set forms up, or this form has no usable template yet. */
  | { kind: "not_ready" }
  /** This guardian hasn't agreed to sign electronically yet. Nothing has been made or read for them. */
  | { kind: "consent" }
  /** Their turn: Documenso's signing frame, at an address that holds this guardian's own token. `origin` is where its messages come from. */
  | { kind: "sign"; frameUrl: string; origin: string }
  /** Someone else's signature is still needed: this guardian has signed, or the form wasn't made for them. */
  | { kind: "waiting"; signedByYou: boolean }
  /** Everyone has signed; Documenso is still making the sealed copy. */
  | { kind: "sealing" }
  | { kind: "complete" }
  /** A guardian declined it. `canRestart`: forms are set up, so it can be started again. */
  | { kind: "declined"; canRestart: boolean }
  /** Documenso can't be asked right now, the form is being made by another open, or it was opened too often. The same words whatever the cause. */
  | { kind: "unavailable" };

export type FormView = {
  step: FormStep;
  /** The state in words, as the Forms list and Home show it. */
  words: string;
  /** Who the document was made for: the family's own guardians, by name. Empty until there is a document. */
  signers: { name: string; signed: boolean; you: boolean }[];
};

const viewOf = (ctx: ParentCtx, row: RequestRow, step: FormStep): FormView => ({
  step, words: wordsFor(row.state, row.signers, ctx.parentId),
  signers: row.signers.map((s) => ({ name: s.name, signed: s.signedAt !== null, you: s.parentId === ctx.parentId })),
});

/**
 * The guardians with a sign-in for an app family, the primary first: people whose membership of the family
 * (guardian.family_id) isn't closed and who aren't blocked. Names and addresses are the portal's own records of them.
 */
async function familyGuardians(familyId: AppFamilyId): Promise<SignerIdentity[]> {
  return db.select({ parentId: parent.id, name: parent.name, email: parent.email }).from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id))
    .where(and(eq(guardian.familyId, familyId), ne(guardian.status, "disabled"), eq(parent.blocked, false)))
    .orderBy(desc(guardian.isPrimary), asc(guardian.createdAt), asc(guardian.id));
}

/**
 * Which of these people can no longer sign for the family at this moment: not an open guardian of it, or blocked. Read
 * FOR SHARE, each person's row first and then their guardian row in the family, the order in which a remove
 * (removeGuardian(), closeMembership()) takes them FOR UPDATE and a block (blockPerson()) takes the person's: so either
 * the close or block waits for this transaction and then finds the document it stored (formsForGoneSigner() starts it
 * again), or this read waits for the close or block and sees it. Empty when every one can still sign.
 */
async function goneSigners(tx: Tx, familyId: AppFamilyId, parentIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(parentIds)].sort();
  if (ids.length === 0) return [];
  const people = await tx.select({ id: parent.id, blocked: parent.blocked }).from(parent).where(inArray(parent.id, ids)).orderBy(asc(parent.id)).for("share");
  const open = await tx.select({ parentId: guardian.parentId }).from(guardian)
    .where(and(eq(guardian.familyId, familyId), inArray(guardian.parentId, ids), ne(guardian.status, "disabled"))).orderBy(asc(guardian.id)).for("share");
  return ids.filter((id) => !people.some((p) => p.id === id && !p.blocked) || !open.some((g) => g.parentId === id));
}

type Made = { ok: true } | { ok: false; reason: "template" | "documenso" };

/**
 * Makes the document for a request that has none, by the verified recipe: names filled in, the guardians as
 * recipients, any signer the template has beyond them deleted before sending, Documenso's emails switched off by both
 * settings whatever the template says, no expiry, the club's time zone, and the request's own id as externalId.
 * The caller holds the request (claim()). The envelope's id is stored as soon as Documenso gives it; if a later call
 * fails, the half-made document is deleted again.
 */
async function makeDocument(ctx: ParentCtx, config: DocumensoConfig, form: MyForm, setting: FormSetting, signers: SignerIdentity[]): Promise<Made> {
  const { row } = form;
  // The template as it is now: staff may have changed it in Documenso since they attached it, and a name field that
  // is no longer read-only would let a signer change a name.
  const template = await asking(() => getEnvelope(config, setting.templateId, PAGE));
  if (!template.ok) return { ok: false, reason: template.code === "not_found" ? "template" : "documenso" };
  const check = checkTemplate(template.value, form.appliesTo);
  if (!check.ok) return { ok: false, reason: "template" };
  const plan: TemplatePlan = check.plan;
  // A template whose signers changed in Documenso since staff attached it is attached again first: a document made from
  // it could never be the one the attached setting expects, and every open would withdraw it and make it again.
  if (plan.signers.length !== setting.signerRoles) return { ok: false, reason: "template" };
  const chosen = signers.slice(0, plan.signers.length);

  // A document an earlier try left behind under this request's id (a crash between calls; Documenso's `use` can't be
  // repeated safely), or one the request lost track of. One with a signature on it, or completed, is taken up again;
  // an unsigned one is deleted. One deleted in Documenso is left as it is.
  const left = await asking(() => findDocumentsByExternalId(config, row.id, PAGE));
  if (!left.ok) return { ok: false, reason: "documenso" };
  for (const old of left.value.filter((e) => e.status === "PENDING" || e.status === "DRAFT" || e.status === "COMPLETED")) {
    const full = await asking(() => getEnvelope(config, old.id, PAGE));
    if (!full.ok) { if (full.code === "not_found") continue; return { ok: false, reason: "documenso" }; }
    if (full.value.externalId !== row.id) continue;
    const reading = readDocument(full.value);
    if (reading.anySigned && reading.state === "gone") continue;
    if (reading.state === "complete" || reading.anySigned) return takeUp(ctx, form, full.value);
    const gone = await asking(() => deleteEnvelope(config, old.id, PAGE));
    if (!gone.ok && gone.code !== "not_found") return { ok: false, reason: "documenso" };
  }

  const club = await getClubSettings();
  const everyRole = chosen.length === plan.signers.length;
  const used = await asking(() => documentFromTemplate(config, {
    envelopeId: plan.templateId, externalId: row.id, distributeDocument: everyRole,
    recipients: chosen.map((s, i) => ({ id: plan.signers[i]!.recipientId, email: s.email, name: s.name })),
    prefillFields: [
      ...plan.subjectFieldIds.map((id) => ({ id, type: "text" as const, value: form.subject.name })),
      ...chosen.flatMap((s, i) => plan.signers[i]!.nameFieldIds.map((id) => ({ id, type: "text" as const, value: s.name }))),
    ],
    override: { title: `${form.line.title} - ${form.subject.name}`.slice(0, TITLE_MAX), distributionMethod: "NONE", emailSettings: EMAILS_OFF,
      timezone: club.timeZone, dateFormat: DATE_FORMAT, envelopeExpirationPeriod: { disabled: true } },
  }, PAGE));
  if (!used.ok) return { ok: false, reason: "documenso" };
  const envelopeId = used.value.id;
  // Stored at once: from here on the document can be found again, whatever happens next.
  await db.update(signatureRequest).set({ envelopeId, envelopeStatus: "DRAFT", updatedAt: new Date() }).where(eq(signatureRequest.id, row.id));

  const undo = async (): Promise<Made> => {
    await asking(() => deleteEnvelope(config, envelopeId, PAGE));
    await db.update(signatureRequest).set({ ...NO_DOCUMENT, updatedAt: new Date() }).where(and(eq(signatureRequest.id, row.id), eq(signatureRequest.envelopeId, envelopeId)));
    return { ok: false, reason: "documenso" };
  };
  const ours = matchRecipients(used.value.recipients, chosen);
  if (!ours) return undo();
  // A signer of the template that was left out is still a recipient until it is deleted (verification, 1a point 1),
  // and its fields go with it. It must go before sending: a prefilled recipient can't be changed afterwards.
  for (const extra of used.value.recipients.filter((r) => !ours.some((o) => o.id === r.id))) {
    const removed = await asking(() => deleteRecipient(config, extra.id, PAGE));
    if (!removed.ok) return undo();
  }
  if (!everyRole) {
    const sent = await asking(() => distributeEnvelope(config, envelopeId, PAGE));
    if (!sent.ok) return undo();
  }

  const made: RequestSigner[] = chosen.map((s, i) => ({ parentId: s.parentId, recipientId: ours[i]!.id, name: s.name, email: s.email, signedAt: null }));
  const now = new Date();
  const stored = await db.transaction(async (tx) => {
    // A signer removed or blocked while the document was being made never gets it: nothing is stored, and it is undone
    // (deleted in Documenso, nobody having signed it) as any failed open is.
    if ((await goneSigners(tx, form.familyId, made.map((s) => s.parentId))).length > 0) return false;
    // The document's id is written again, and only while this open still holds the request: a request is never left waiting with no document.
    const [kept] = await tx.update(signatureRequest).set({ state: "waiting", envelopeId, envelopeStatus: "PENDING", templateId: plan.templateId, templateUpdatedAt: new Date(plan.updatedAt), signersMode: setting.signers,
      subjectName: form.subject.name, signers: made, documentCreatedAt: now, checkedAt: now, allSignedAt: null, sealAskedAt: null, completedAt: null, declinedAt: null, updatedAt: now })
      .where(and(eq(signatureRequest.id, row.id), isNotNull(signatureRequest.preparingAt))).returning({ id: signatureRequest.id });
    if (!kept) return false;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "form.document.create", targetType: "signature_request", targetId: row.id, ip: ctx.ip,
      after: { envelopeId, templateId: plan.templateId, templateUpdatedAt: plan.updatedAt, signers: setting.signers, ...requestRecords(row),
        subjectName: form.subject.name, madeFor: made.map((s) => ({ parentId: s.parentId, name: s.name, email: s.email })) } }, tx);
    return true;
  });
  return stored ? { ok: true } : undo();
}

/**
 * Takes up a document of this request that holds a signature, or is complete, which the request no longer points at
 * (it was reset while Documenso could not be read properly). Its recipients are matched to portal people by address,
 * as the portal made them; the state is then read from Documenso like at any other open. The caller holds the request.
 */
async function takeUp(ctx: ParentCtx, form: MyForm, envelope: Envelope): Promise<Made> {
  const { row } = form;
  const recipients = envelope.recipients.filter((r) => r.role === "SIGNER");
  const emails = recipients.map((r) => r.email.toLowerCase());
  const people = emails.length === 0 ? [] : await db.select({ id: parent.id, email: parent.email }).from(parent).where(inArray(parent.email, emails));
  const signers: RequestSigner[] = recipients.map((r) => ({ parentId: people.find((p) => p.email === r.email.toLowerCase())?.id ?? "", recipientId: r.id, name: r.name, email: r.email, signedAt: null }));
  const now = new Date();
  // The guardians it still waits for (a complete one waits for nobody): each must still be able to sign for the family.
  const waitingOn = envelope.status === "COMPLETED" ? [] : signers.filter((s, i) => s.parentId !== "" && recipients[i]!.signingStatus !== "SIGNED").map((s) => s.parentId);
  return db.transaction(async (tx) => {
    const gone = await goneSigners(tx, form.familyId, waitingOn);
    if (gone.length > 0) {
      // Never taken up: it is withdrawn by the worker (cancelled, as it holds a signature), as formsForGoneSigner() does
      // for a document the request still points at, and the request stays not opened, to be made again.
      await tx.insert(formWithdrawal).values({ envelopeId: envelope.id, anySigned: true }).onConflictDoNothing();
      await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "forms.request.signer_gone", targetType: "signature_request", targetId: row.id, ip: ctx.ip,
        before: { state: row.state, envelopeId: envelope.id }, after: { state: "not_opened", parentIds: gone, ...requestRecords(row), reason: "gone_before_taken_up", withdraw: "cancel" } }, tx);
      return { ok: false, reason: "documenso" } as const;
    }
    const [kept] = await tx.update(signatureRequest).set({ ...NO_DOCUMENT, state: "waiting", envelopeId: envelope.id, envelopeStatus: envelope.status, subjectName: form.subject.name, signers,
      documentCreatedAt: now, checkedAt: null, updatedAt: now })
      .where(and(eq(signatureRequest.id, row.id), isNull(signatureRequest.envelopeId), isNotNull(signatureRequest.preparingAt))).returning({ id: signatureRequest.id });
    if (!kept) return { ok: false, reason: "documenso" } as const;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "form.document.recover", targetType: "signature_request", targetId: row.id, ip: ctx.ip,
      after: { envelopeId: envelope.id, documensoStatus: envelope.status, ...requestRecords(row), madeFor: signers.map((s) => ({ parentId: s.parentId || null, name: s.name, email: s.email })) } }, tx);
    return { ok: true } as const;
  });
}

/** Which of the new document's recipients is each guardian: by address (no two people share one in the portal), else by place. Null when it can't be told. */
function matchRecipients(recipients: readonly EnvelopeRecipient[], chosen: readonly SignerIdentity[]): EnvelopeRecipient[] | null {
  const inOrder = [...recipients].sort((a, b) => (a.signingOrder ?? Number.MAX_SAFE_INTEGER) - (b.signingOrder ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
  const ours = chosen.map((s, i) => {
    const byEmail = recipients.filter((r) => r.email.toLowerCase() === s.email.toLowerCase());
    return byEmail.length === 1 ? byEmail[0]! : inOrder[i];
  });
  if (ours.some((r, i) => !r || r.email.toLowerCase() !== chosen[i]!.email.toLowerCase())) return null;
  return new Set(ours.map((r) => r!.id)).size === ours.length ? (ours as EnvelopeRecipient[]) : null;
}

/**
 * Each open of a form, and each check of one, asks Documenso once, and Documenso counts every call the portal makes
 * against one limit: so they are counted per person (RATE_LIMITS). The first refusal of a full window is audited.
 */
async function mayAsk(ctx: ParentCtx, row: RequestRow): Promise<boolean> {
  const take = await takeRateLimit("form_open_parent", ctx.parentId);
  if (take === "first_refusal") await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "form.open.refused", targetType: "signature_request", targetId: row.id, after: { code: "rate_limited" }, ip: ctx.ip });
  return take === "taken";
}

/** Withdraws a document nobody has signed, because it is no longer the right one, and records why. */
async function withdraw(ctx: ParentCtx, config: DocumensoConfig, row: RequestRow, reason: string): Promise<boolean> {
  const gone = await asking(() => deleteEnvelope(config, row.envelopeId!, PAGE));
  if (!gone.ok && gone.code !== "not_found") return false;
  await db.transaction(async (tx) => {
    await tx.update(signatureRequest).set({ ...NO_DOCUMENT, updatedAt: new Date() }).where(and(eq(signatureRequest.id, row.id), eq(signatureRequest.envelopeId, row.envelopeId!)));
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "form.document.withdraw", targetType: "signature_request", targetId: row.id, ip: ctx.ip,
      before: { envelopeId: row.envelopeId, madeFor: row.signers.map((s) => ({ parentId: s.parentId, name: s.name })), subjectName: row.subjectName }, after: { reason } }, tx);
  });
  return true;
}

/** The step for a request as it stands after a reading, for this guardian. The token comes from `envelope`, read just now. */
function stepFor(ctx: ParentCtx, config: DocumensoConfig, row: RequestRow, envelope: Envelope | null): FormStep {
  if (row.state === "complete") return { kind: "complete" };
  if (row.state === "declined") return { kind: "declined", canRestart: true };
  if (row.state === "signed") return { kind: "sealing" };
  if (row.state !== "waiting" || !envelope) return { kind: "unavailable" };
  const mine = row.signers.find((s) => s.parentId === ctx.parentId);
  if (!mine) return { kind: "waiting", signedByYou: false };
  if (mine.signedAt !== null) return { kind: "waiting", signedByYou: true };
  // The token goes only to its own recipient: the recipient the portal made for this signed-in person, on the
  // document that carries this request's id, still named and addressed as the portal made it.
  const recipient = envelope.externalId === row.id && envelope.id === row.envelopeId ? envelope.recipients.find((r) => r.id === mine.recipientId) : undefined;
  if (!recipient || recipient.role !== "SIGNER" || recipient.email.toLowerCase() !== mine.email.toLowerCase() || !recipient.token) return { kind: "unavailable" };
  return { kind: "sign", frameUrl: signingFrameUrl(config.origin, recipient.token, mine.name), origin: config.origin };
}

/**
 * The view for a step. Handing a guardian their signing frame gives out a credential, so it is audited each time
 * (spec §9.4): which signed-in guardian, from which address, was given which recipient of which document. The
 * certificate says only "Authentication Level: Email"; these rows are what ties a signature to a signed-in guardian.
 */
async function shown(ctx: ParentCtx, row: RequestRow, step: FormStep): Promise<FormView> {
  if (step.kind === "sign") {
    const mine = row.signers.find((s) => s.parentId === ctx.parentId)!;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "form.sign.open", targetType: "signature_request", targetId: row.id, ip: ctx.ip,
      after: { envelopeId: row.envelopeId, recipientId: mine.recipientId, parentId: ctx.parentId, name: mine.name, email: mine.email, ...requestRecords(row) } });
  }
  return viewOf(ctx, row, step);
}

/**
 * Opens a form for the signed-in guardian: what the form page shows. Nothing is read from Documenso or made there
 * until this guardian has agreed to sign electronically. Then the document is read (or made, on the first open), and
 * when it is this guardian's turn the answer holds the address of the signing frame with their own token.
 */
export async function openMyForm(ctx: ParentCtx, form: MyForm): Promise<FormView> {
  return open(ctx, form, true);
}

async function open(ctx: ParentCtx, form: MyForm, mayWait: boolean): Promise<FormView> {
  let { row } = form;
  // Finished one way or the other: what the portal last stored is all there is to say, and Documenso isn't asked.
  // A form signed by another family's guardians before its student moved here says only that it is signed: who signed
  // it is that family's (signedWithin()).
  if (row.state === "complete") {
    const view = viewOf(ctx, row, { kind: "complete" });
    return (await signedWithin(form.familyId, row.signers)) ? view : { ...view, signers: [] };
  }
  const config = await getFormsConfig();
  if (row.state === "declined") return viewOf(ctx, row, { kind: "declined", canRestart: config !== null && form.setting !== null });
  if (!config || !form.setting) return viewOf(ctx, row, { kind: "not_ready" });
  if (!(await hasConsent(row.id, ctx.parentId))) {
    // Nothing is asked of a guardian a signed form doesn't wait for: everyone has signed, or someone has and it isn't
    // waiting for them. What the portal last stored is said, and Documenso isn't asked.
    const mine = row.signers.find((s) => s.parentId === ctx.parentId);
    if (row.state === "signed") return viewOf(ctx, row, { kind: "sealing" });
    if (row.state === "waiting" && holdsSignature(row) && (!mine || mine.signedAt !== null)) return viewOf(ctx, row, { kind: "waiting", signedByYou: mine !== undefined });
    return viewOf(ctx, row, { kind: "consent" });
  }
  const setting = form.setting;
  const actor = { actor: parentActor({ id: ctx.parentId, email: ctx.email }), ip: ctx.ip };
  if (!(await mayAsk(ctx, row))) return viewOf(ctx, row, { kind: "unavailable" });

  const guardians = await familyGuardians(form.familyId);
  // Only a guardian of the family at this moment signs: one removed or blocked since their session began gets the same
  // words as any refusal, and no token. The store checks it again, under locks a remove and a block wait for.
  const viewer = guardians.find((g) => g.parentId === ctx.parentId);
  if (!viewer) return viewOf(ctx, row, { kind: "unavailable" });

  let envelope: Envelope | null = null;
  if (row.envelopeId !== null) {
    const read = await readAndStore(row, config, { ...actor, ...PAGE });
    if (!read.ok) return isHeld(read.row) ? afterTheHold(ctx, form, row, mayWait) : viewOf(ctx, row, { kind: "unavailable" });
    row = read.row; envelope = read.envelope;
    // Once anyone has signed, the document is left alone, whoever is on it and whatever has changed since.
    if (row.envelopeId !== null && (read.reading?.anySigned || row.state !== "waiting")) return shown(ctx, row, stepFor(ctx, config, row, envelope));
    const right = row.envelopeId !== null && stillRight(
      { templateId: row.templateId, templateUpdatedAt: row.templateUpdatedAt?.getTime() ?? null, mode: row.signersMode, subjectName: row.subjectName, signers: row.signers },
      { templateId: setting.templateId, templateUpdatedAt: new Date(setting.templateUpdatedAt).getTime(), mode: setting.signers, roles: setting.signerRoles, subjectName: form.subject.name, viewer, guardians });
    if (right) return shown(ctx, row, stepFor(ctx, config, row, envelope));
  }

  // No document, or one nobody has signed that is no longer the right one: withdraw it and make it again.
  if (!(await claim(row.id))) return afterTheHold(ctx, form, row, mayWait);
  try {
    if (row.envelopeId !== null) {
      const why = row.signers.some((s) => s.parentId === ctx.parentId) ? "The names, the guardians or the template changed before anyone signed" : "Another guardian opened it before anyone signed";
      if (!(await withdraw(ctx, config, row, why))) return viewOf(ctx, row, { kind: "unavailable" });
    }
    const made = await makeDocument(ctx, config, { ...form, row }, setting, signersFor(setting.signers, setting.signerRoles, viewer, guardians));
    const [fresh] = await db.select().from(signatureRequest).where(eq(signatureRequest.id, row.id));
    row = fresh ?? row;
    if (!made.ok) return viewOf(ctx, row, { kind: made.reason === "template" ? "not_ready" : "unavailable" });
  } finally {
    await release(row.id);
  }
  // The token is read from Documenso like at any other open, not kept from the call that made the document.
  const read = await readAndStore(row, config, { ...actor, ...PAGE });
  if (!read.ok) return viewOf(ctx, row, { kind: "unavailable" });
  return shown(ctx, read.row, stepFor(ctx, config, read.row, read.envelope));
}

/**
 * Another open is making this document right now (the page drawn twice, or the other guardian at the same moment).
 * When it has finished, this open reads what it made; it never makes a second one.
 */
async function afterTheHold(ctx: ParentCtx, form: MyForm, row: RequestRow, mayWait: boolean): Promise<FormView> {
  const settled = mayWait ? await whenReleased(row.id) : null;
  return settled ? open(ctx, { ...form, row: settled }, false) : viewOf(ctx, row, { kind: "unavailable" });
}

export type FormActionResult ={ ok: true; message: string } | { ok: false; errors: string[] };
/** One refusal for an id that isn't the family's own form, whatever the reason: it never says another family's form exists. */
export const NOT_YOUR_FORM: FormActionResult = { ok: false, errors: ["That form isn't here. Go back to Forms and open it again."] };
const CANT_ASK = "We couldn't check this form just now. Please try again in a few minutes.";

/**
 * Records that the signed-in guardian agrees to sign this form electronically: who, when, from which address, and
 * which version of the text. The form is found within the session's family; nothing is made in Documenso here.
 */
export async function agreeToSign(ctx: ParentCtx, requestId: unknown, userAgent: string | null): Promise<FormActionResult> {
  const form = await findMyForm(ctx, requestId);
  if (!form) return NOT_YOUR_FORM;
  if (form.row.state === "complete") return { ok: true, message: "This form is already signed." };
  if (!form.setting || !(await getFormsConfig())) return { ok: false, errors: ["This form isn't ready to sign yet. Nothing is needed from you right now."] };
  await db.transaction(async (tx) => {
    const made = await recordConsent(tx, { requestId: form.row.id, parentId: ctx.parentId, name: ctx.name, email: ctx.email, ip: ctx.ip, userAgent });
    if (made) await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "form.consent.agree", targetType: "signature_request", targetId: form.row.id, ip: ctx.ip,
      after: { ...requestRecords(form.row), requirementId: form.row.requirementId } }, tx);
  });
  return { ok: true, message: "Thank you. The form is next." };
}

/**
 * Asks Documenso how the form stands and stores the answer: what the page calls when the signing frame says this
 * guardian has finished. The frame's message itself records nothing. The answer is the state in words.
 */
export async function checkMyForm(ctx: ParentCtx, requestId: unknown): Promise<FormActionResult & { state?: RequestRow["state"] }> {
  const form = await findMyForm(ctx, requestId);
  if (!form) return NOT_YOUR_FORM;
  const { row } = form;
  if (row.state === "complete" || row.state === "declined" || row.envelopeId === null) return { ok: true, message: wordsFor(row.state, row.signers, ctx.parentId), state: row.state };
  const config = await getFormsConfig();
  if (!config || !(await hasConsent(row.id, ctx.parentId))) return { ok: false, errors: [CANT_ASK] };
  if (!(await mayAsk(ctx, row))) return { ok: false, errors: [CANT_ASK] };
  const read = await readAndStore(row, config, { actor: parentActor({ id: ctx.parentId, email: ctx.email }), ip: ctx.ip, ...PAGE });
  if (!read.ok) return { ok: false, errors: [CANT_ASK] };
  return { ok: true, message: wordsFor(read.row.state, read.row.signers, ctx.parentId), state: read.row.state };
}

/**
 * Starts a declined form again: the declined document stays in Documenso as it is, and the request goes back to not
 * opened, so the next open makes a new document. Only a declined form can be started again.
 */
export async function startMyFormAgain(ctx: ParentCtx, requestId: unknown): Promise<FormActionResult> {
  const form = await findMyForm(ctx, requestId);
  if (!form) return NOT_YOUR_FORM;
  const { row } = form;
  if (row.state !== "declined") return { ok: false, errors: ["This form can't be started again: it wasn't declined."] };
  const done = await db.transaction(async (tx) => {
    const cleared = await tx.update(signatureRequest).set({ ...NO_DOCUMENT, updatedAt: new Date() })
      .where(and(eq(signatureRequest.id, row.id), eq(signatureRequest.familyId, form.familyId), eq(signatureRequest.state, "declined"))).returning({ id: signatureRequest.id });
    if (cleared.length === 0) return false;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "form.document.restart", targetType: "signature_request", targetId: row.id, ip: ctx.ip,
      before: { state: "declined", envelopeId: row.envelopeId, declinedAt: row.declinedAt?.toISOString() ?? null }, after: { state: "not_opened" } }, tx);
    return true;
  });
  return done ? { ok: true, message: "Started again. You can sign it now." } : { ok: false, errors: ["This form can't be started again: it wasn't declined."] };
}
