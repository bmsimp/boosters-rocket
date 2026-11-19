import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, requirement, requirementCover, setting, signatureConsent, signatureRequest, signedFormEvidence, signedFormFile, type FormSetting, type RequestSigner, type SignatureRequestState } from "@/lib/db/schema";
import { getRosterSource } from "@/lib/roster/source";
import { secretBox } from "@/lib/crypto/secret-box";
import { CONSENT_VERSION } from "@/lib/forms/consent";
import { FORMS_AAD, FORMS_KEY } from "@/lib/forms/settings";
import type { ParentFamilySpec } from "./parent";
import type { SeededSeason } from "./season";
import { subjectColumns } from "./app-records";
import { familyRecord, studentRecord } from "./volunteer";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";

/**
 * Forms for tests: the connection to Documenso as an Admin would have saved it, form requirements with a template
 * attached, and requests in whatever state, written straight into the tables. To talk to a Documenso, start the stub
 * (tests/helpers/documenso-stub.ts) and pass it to connectForms(): the portal's real client then calls it.
 */

/** Stores the forms settings: Documenso at `origin` with this API token, and a webhook secret. Returns the secret. */
export async function connectForms(documenso: { origin: string; token: string }, o: { webhookSecret?: string | null } = {}): Promise<{ webhookSecret: string | null }> {
  const webhookSecret = o.webhookSecret === undefined ? "stub-webhook-secret-0123456789" : o.webhookSecret;
  const token = secretBox().seal(documenso.token, FORMS_AAD.token);
  const secret = webhookSecret === null ? null : secretBox().seal(webhookSecret, FORMS_AAD.webhookSecret);
  const value = { origin: documenso.origin, tokenCiphertext: token.ciphertext, tokenKeyId: token.keyId, webhookSecretCiphertext: secret?.ciphertext ?? null, webhookSecretKeyId: secret?.keyId ?? null };
  await db.insert(setting).values({ key: FORMS_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
  return { webhookSecret };
}

/** What staff's attach would have stored for a template (attachTemplate in src/lib/forms/attach.ts). */
export const formSetting = (template: { id: string; title?: string; updatedAt?: string }, o: { signers?: "any" | "every"; signerRoles?: 1 | 2 } = {}): FormSetting => ({
  templateId: template.id, templateTitle: template.title ?? "Commitment form", templateUpdatedAt: template.updatedAt ?? "2026-11-01T12:00:00.000Z",
  signerRoles: o.signerRoles ?? 2, signers: o.signers ?? "any", attachedAt: "2026-11-02T12:00:00.000Z",
});

/** A form requirement at the end of a step. `form` null leaves it with no template attached. Optional by default, so it holds no step open. */
export async function seedFormRequirement(o: { stepId: string; title: string; appliesTo: "family" | "student"; form: FormSetting | null; required?: boolean; chosen?: string[]; position?: number }): Promise<string> {
  const [row] = await db.insert(requirement).values({ stepId: o.stepId, kind: "form", title: o.title, required: o.required ?? false, appliesTo: o.appliesTo,
    covers: o.chosen ? "chosen" : "everyone", position: o.position ?? 50, form: o.form }).returning({ id: requirement.id });
  // A chosen list names the app's own records (stage 2 of the app-owned families spec), given here by QuickBooks id.
  for (const subjectQboId of o.chosen ?? []) await db.insert(requirementCover).values({ requirementId: row!.id, ...(await subjectColumns(subjectQboId, o.appliesTo)) });
  return row!.id;
}

/**
 * A request is given here by its family's and subject's QuickBooks ids, as the tests name families, and stored by the
 * app's own records they are linked to (stage 2 of the app-owned families spec): the family's record, and for a
 * per-student requirement the student's (familyRecord(), studentRecord(), which import the records from the cache first
 * when a customer has none yet, so a test that seeds one seeds a roster company first).
 */
export type SeedRequest = {
  requirementId: string; familyQboId: string; subjectQboId: string; state?: SignatureRequestState;
  envelopeId?: string | null; signers?: RequestSigner[]; subjectName?: string; form?: FormSetting;
  checkedAt?: Date | null; allSignedAt?: Date | null; sealAskedAt?: Date | null; evidenceOwed?: boolean;
};
/** One request as the portal would have left it in that state. Returns its id. */
export async function seedRequest(o: SeedRequest): Promise<string> {
  const state = o.state ?? "not_opened", has = state !== "not_opened";
  const now = new Date();
  const [r] = await db.select({ appliesTo: requirement.appliesTo }).from(requirement).where(eq(requirement.id, o.requirementId));
  const [row] = await db.insert(signatureRequest).values({
    requirementId: o.requirementId, familyId: await familyRecord(o.familyQboId), studentId: r?.appliesTo === "student" ? await studentRecord(o.subjectQboId) : null, state,
    envelopeId: has ? (o.envelopeId ?? `envelope_seed${Math.random().toString(36).slice(2, 12)}`) : null,
    envelopeStatus: !has ? null : state === "complete" ? "COMPLETED" : state === "declined" ? "REJECTED" : "PENDING",
    templateId: has ? (o.form?.templateId ?? "envelope_seedtemplate") : null, templateUpdatedAt: has ? new Date(o.form?.templateUpdatedAt ?? "2026-11-01T12:00:00.000Z") : null,
    signersMode: has ? (o.form?.signers ?? "any") : null, subjectName: has ? (o.subjectName ?? null) : null, signers: has ? (o.signers ?? []) : [],
    documentCreatedAt: has ? now : null, checkedAt: o.checkedAt === undefined ? (has ? now : null) : o.checkedAt,
    allSignedAt: o.allSignedAt === undefined ? (state === "signed" || state === "complete" ? now : null) : o.allSignedAt, sealAskedAt: o.sealAskedAt ?? null,
    completedAt: state === "complete" ? now : null, declinedAt: state === "declined" ? now : null, evidenceOwed: o.evidenceOwed ?? state === "complete",
  }).returning({ id: signatureRequest.id });
  return row!.id;
}

/** A guardian's agreement to sign one request electronically, as the consent step records it. */
export async function seedConsent(requestId: string, who: { parentId: string; name: string; email: string }, textVersion: string = CONSENT_VERSION): Promise<void> {
  await db.insert(signatureConsent).values({ requestId, parentId: who.parentId, parentName: who.name, parentEmail: who.email, textVersion, ip: "203.0.113.50" });
}

/** Made-up PDF bytes that say what they are: enough for a download test to recognize, and nothing a reader would open. */
export const fakePdf = (text: string): Buffer => Buffer.from(`%PDF-1.7\n% ${text}\n%%EOF\n`, "latin1");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export type SeededEvidence = { id: string; sealed: Buffer; sealedSha256: string; files: { kind: string; sha256: string }[] };
/**
 * The evidence the worker would have kept for a complete request (src/lib/signed-forms/evidence-job.ts): the row with
 * the names as they were, and its four files, with made-up PDF bytes. The company is the roster cache's, unless given,
 * and none when the request's family has no link there (as the job keeps it: a family with no link keeps no copy and no
 * company, and a student with none keeps no subject copy). Clears the request's `evidence_owed`, as storing does.
 */
export async function seedEvidence(requestId: string, o: { tag: string; formTitle?: string; familyName?: string; subjectName?: string; realmId?: string | null; earlierCompanyAt?: Date | null;
  consents?: { parentId: string; name: string; email: string }[]; copiesDone?: boolean } = { tag: "seeded" }): Promise<SeededEvidence> {
  const row = await requestNow(requestId);
  const sealed = fakePdf(`sealed ${o.tag}`);
  const files = [
    { kind: "sealed_pdf" as const, itemId: `envelope_item_${o.tag.replace(/\W/g, "").slice(0, 20)}1x`, bytes: sealed },
    { kind: "certificate_pdf" as const, itemId: null, bytes: fakePdf(`certificate ${o.tag}`) },
    { kind: "audit_log_pdf" as const, itemId: null, bytes: fakePdf(`audit log ${o.tag}`) },
    { kind: "audit_log_json" as const, itemId: null, bytes: Buffer.from(JSON.stringify({ envelopeId: row.envelopeId, count: 1, entries: [{ type: "DOCUMENT_COMPLETED", tag: o.tag }] })) },
  ];
  // The customers of the request's records, which the evidence keeps as its own copies (null with no link); the app's
  // records only for the current company's evidence (an earlier company's names none: signed_form_evidence_app_records).
  const familyQboId = await linkedCustomer(row.familyId);
  const subjectQboId = familyQboId === null ? null : row.studentId === null ? familyQboId : await linkedCustomer(row.studentId);
  const [evidence] = await db.insert(signedFormEvidence).values({
    requestId: o.earlierCompanyAt ? null : requestId, realmId: o.realmId !== undefined ? o.realmId : familyQboId === null ? null : await getRosterSource(), earlierCompanyAt: o.earlierCompanyAt ?? null,
    requirementId: row.requirementId, familyQboId, subjectQboId, subjectKind: row.studentId === null ? "family" : "student",
    familyId: o.earlierCompanyAt ? null : row.familyId, studentId: o.earlierCompanyAt ? null : row.studentId,
    formTitle: o.formTitle ?? "Seeded form", familyName: o.familyName ?? null, subjectName: o.subjectName ?? row.subjectName, seasonName: null,
    envelopeId: row.envelopeId ?? `envelope_seed${o.tag.replace(/\W/g, "")}`, templateId: row.templateId, templateUpdatedAt: row.templateUpdatedAt,
    signers: row.signers.map((s) => ({ parentId: s.parentId, name: s.name, email: s.email, signedAt: s.signedAt })),
    consents: (o.consents ?? []).map((c) => ({ ...c, textVersion: CONSENT_VERSION, agreedAt: "2026-11-10T14:00:00.000Z", ip: "203.0.113.50", userAgent: null })),
    originals: [{ itemId: files[0]!.itemId!, sha256: hash(fakePdf(`original ${o.tag}`)), size: 64 }],
    completedAt: row.completedAt, copiesDoneAt: o.copiesDone === false ? null : new Date(),
  }).returning({ id: signedFormEvidence.id });
  await db.insert(signedFormFile).values(files.map((f) => ({ evidenceId: evidence!.id, kind: f.kind, position: 1, itemId: f.itemId, bytes: f.bytes, size: f.bytes.byteLength, sha256: hash(f.bytes) })));
  await db.update(signatureRequest).set({ evidenceOwed: false }).where(eq(signatureRequest.id, requestId));
  return { id: evidence!.id, sealed, sealedSha256: hash(sealed), files: files.map((f) => ({ kind: f.kind, sha256: hash(f.bytes) })) };
}

/**
 * A request whose document is real in the Documenso stub and signed by everyone on it: made from `templateId` with
 * this request's id as externalId, each guardian a recipient, then signed (and sealed, unless the stub holds sealing
 * back). The request is stored as the portal would have left it: complete (or signed), `evidence_owed` set.
 */
export async function signedInStub(stub: { origin: string; token: string; envelopes: Map<string, { recipients: { id: number; email: string }[] }>; sign(envelopeId: string, who: string): void },
  o: { requirementId: string; templateId: string; familyQboId: string; subjectQboId: string; subjectName?: string; guardians: { parentId: string; name: string; email: string }[]; items?: number; sign?: boolean }): Promise<{ id: string; envelopeId: string }> {
  const id = await seedRequest({ requirementId: o.requirementId, familyQboId: o.familyQboId, subjectQboId: o.subjectQboId, state: "waiting", envelopeId: `envelope_pending${Math.random().toString(36).slice(2, 10)}`, subjectName: o.subjectName });
  const template = stub.envelopes.get(o.templateId)!;
  const made = await (await fetch(`${stub.origin}/api/v2/envelope/use`, { method: "POST", headers: { authorization: stub.token, "content-type": "application/json" },
    body: JSON.stringify({ envelopeId: o.templateId, externalId: id, distributeDocument: true, recipients: o.guardians.map((g, i) => ({ id: template.recipients[i]!.id, email: g.email, name: g.name })) }) })).json() as { id: string; recipients: { id: number; email: string }[] };
  const doc = stub.envelopes.get(made.id) as unknown as { items?: number; recipients: { id: number; email: string }[]; status: string };
  if (o.items) doc.items = o.items;
  const at = new Date().toISOString();
  if (o.sign !== false) for (const g of o.guardians) stub.sign(made.id, g.email);
  const done = doc.status === "COMPLETED";
  await db.update(signatureRequest).set({
    envelopeId: made.id, envelopeStatus: doc.status, state: o.sign === false ? "waiting" : done ? "complete" : "signed", completedAt: done ? new Date() : null, allSignedAt: o.sign === false ? null : new Date(),
    evidenceOwed: done, signers: o.guardians.map((g) => ({ parentId: g.parentId, name: g.name, email: g.email, recipientId: doc.recipients.find((r) => r.email === g.email)!.id, signedAt: o.sign === false ? null : at })),
  }).where(eq(signatureRequest.id, id));
  return { id, envelopeId: made.id };
}

/** The customer a family or student record is linked to, in the roster's company, or null when it has no link there. */
async function linkedCustomer(id: AppFamilyId | AppStudentId): Promise<string | null> {
  const realmId = await getRosterSource();
  const links = await db.select({ customerId: accountingLink.customerId, familyId: accountingLink.familyId, studentId: accountingLink.studentId }).from(accountingLink)
    .where(and(eq(accountingLink.realmId, realmId ?? ""), eq(accountingLink.system, "quickbooks")));
  return links.find((x) => String(x.familyId) === String(id) || String(x.studentId) === String(id))?.customerId ?? null;
}
/** The same, for a test that names families by customer: a record with no link is the test's mistake. */
async function customerOf(id: AppFamilyId | AppStudentId): Promise<string> {
  const found = await linkedCustomer(id);
  if (found === null) throw new Error("requestCustomers: the request's family or student record has no link in the roster's company");
  return found;
}

/**
 * The customers a request's family and subject records are linked to, in the roster's company: what a test that names
 * families by QuickBooks id compares with. The request itself holds only the app's ids.
 */
export async function requestCustomers(id: string): Promise<{ familyQboId: string; subjectQboId: string }> {
  const row = await requestNow(id);
  const familyQboId = await customerOf(row.familyId);
  return { familyQboId, subjectQboId: row.studentId === null ? familyQboId : await customerOf(row.studentId) };
}

/**
 * The Forms page's group of the family or student with this QuickBooks id: a group's `key` is the app record's own id,
 * found here through the customer's links (of either kind) in the roster's company.
 */
export async function groupOf<G extends { key: string }>(groups: readonly G[], qboId: string): Promise<G | undefined> {
  const realmId = await getRosterSource();
  const links = await db.select({ familyId: accountingLink.familyId, studentId: accountingLink.studentId }).from(accountingLink)
    .where(and(eq(accountingLink.realmId, realmId ?? ""), eq(accountingLink.system, "quickbooks"), eq(accountingLink.customerId, qboId)));
  const keys = new Set(links.flatMap((l) => [l.familyId, l.studentId].filter((x) => x !== null).map(String)));
  return groups.find((g) => keys.has(g.key));
}

/** A request as stored, with the customers its records are linked to beside it (requestCustomers()). */
export const requestByCustomer = async (id: string) => ({ ...(await requestNow(id)), ...(await requestCustomers(id)) });

export const requestNow = async (id: string) => (await db.select().from(signatureRequest).where(eq(signatureRequest.id, id)))[0]!;

const signer = (parentId: string, name: string, email: string, recipientId: number, signedAt: string | null = null): RequestSigner => ({ parentId, recipientId, name, email, signedAt });

export type FamilyForms = {
  /** Strings that belong to this family's forms alone: its request ids, its documents' ids, a form asked only of it, its other guardian's name. */
  markers: string[];
  /** What this family's parent must find on the Forms page: each form's title and its state in words. */
  page: string[];
  /** The family's request in each state, by state; `waitingOther` is the one the family's parent has signed and its other guardian has not. */
  ids: Record<SignatureRequestState | "waitingOther", string>;
  /** The kept evidence of the family's complete request: its id and the sealed PDF's bytes and hash. */
  evidence: SeededEvidence;
};

/**
 * Forms for family A and family B in the season seedTwoFamilies() gives them: a form requirement asked of each family,
 * one asked of each student, one asked of one family alone, and a request in every state for both families. The form
 * requirements are optional, so the steps the two families are on, and what is left to do in them, stay as they were.
 * Forms are NOT set up here (no Documenso address is stored): the pages show what the portal last stored, and nothing
 * can call out. `who` is each family's signed-in parent.
 */
export async function seedTwoFamilyForms(a: { spec: ParentFamilySpec; parentId: string }, b: { spec: ParentFamilySpec; parentId: string }, season: SeededSeason): Promise<{ a: FamilyForms; b: FamilyForms }> {
  const signUp = season.stepIds["Sign-up"]!, uniforms = season.stepIds["Uniforms"]!;
  const any = formSetting({ id: "envelope_seedtemplateany", title: "Seeded template" }), every = formSetting({ id: "envelope_seedtemplateevery", title: "Seeded template for two" }, { signers: "every" });
  const travel = await seedFormRequirement({ stepId: signUp, title: "Travel consent", appliesTo: "family", form: any });
  const agreement = await seedFormRequirement({ stepId: uniforms, title: "Uniform agreement", appliesTo: "student", form: any });
  const photo = await seedFormRequirement({ stepId: uniforms, title: "Photo release", appliesTo: "student", form: every });

  const one = async (family: { spec: ParentFamilySpec; parentId: string }, tag: string, own: { title: string; otherGuardian: string }): Promise<FamilyForms> => {
    const { spec, parentId } = family;
    const me = (signedAt: string | null = null) => signer(parentId, spec.parent.name, spec.parent.email, 1, signedAt);
    const ownRequirement = await seedFormRequirement({ stepId: signUp, title: own.title, appliesTo: "family", form: any, chosen: [spec.family.qboId] });
    const base = { familyQboId: spec.family.qboId };
    const [s1, s2] = spec.students as [{ qboId: string; name: string }, { qboId: string; name: string }];
    const signedAt = "2026-11-10T15:00:00.000Z";
    const ids = {
      waiting: await seedRequest({ ...base, requirementId: travel, subjectQboId: spec.family.qboId, state: "waiting", envelopeId: `envelope_${tag}waiting`, signers: [me()], subjectName: spec.family.name }),
      not_opened: await seedRequest({ ...base, requirementId: ownRequirement, subjectQboId: spec.family.qboId }),
      signed: await seedRequest({ ...base, requirementId: agreement, subjectQboId: s1.qboId, state: "signed", envelopeId: `envelope_${tag}signed`, signers: [me(signedAt)], subjectName: s1.name }),
      complete: await seedRequest({ ...base, requirementId: agreement, subjectQboId: s2.qboId, state: "complete", envelopeId: `envelope_${tag}complete`, signers: [me(signedAt)], subjectName: s2.name }),
      declined: await seedRequest({ ...base, requirementId: photo, subjectQboId: s1.qboId, state: "declined", envelopeId: `envelope_${tag}declined`, signers: [me()], subjectName: s1.name, form: every }),
      waitingOther: await seedRequest({ ...base, requirementId: photo, subjectQboId: s2.qboId, state: "waiting", envelopeId: `envelope_${tag}other`, subjectName: s2.name, form: every,
        signers: [me(signedAt), signer(crypto.randomUUID(), own.otherGuardian, `${tag}.other.guardian@forms.example`, 2)] }),
    };
    // The complete one's evidence, as the worker would have kept it: the sealed PDF's bytes say whose it is.
    const evidence = await seedEvidence(ids.complete, { tag: `${tag} signed form`, formTitle: "Uniform agreement", familyName: spec.family.name, subjectName: s2.name,
      consents: [{ parentId, name: spec.parent.name, email: spec.parent.email }] });
    return {
      ids, evidence,
      markers: [...Object.values(ids), ...["waiting", "signed", "complete", "declined", "other"].map((s) => `envelope_${tag}${s}`), own.title, ownRequirement, own.otherGuardian, `${tag}.other.guardian@forms.example`,
        evidence.id, evidence.sealedSha256, `sealed ${tag} signed form`],
      page: ["Travel consent", own.title, "Uniform agreement", "Photo release", "Not signed yet", "Waiting for the other guardian", "Signed, being finished", "Signed", "Declined"],
    };
  };
  return {
    a: await one(a, "alderquist", { title: "Bus waiver QA74", otherGuardian: "Ottoline Alderquist-Voss" }),
    b: await one(b, "brackenmoor", { title: "Field trip waiver QB85", otherGuardian: "Benedikt Brackenmoor-Hale" }),
  };
}
