import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, requirementCover, setting, signatureConsent, signatureRequest, type FormSetting, type RequestSigner, type SignatureRequestState } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";
import { CONSENT_VERSION } from "@/lib/forms/consent";
import { FORMS_AAD, FORMS_KEY } from "@/lib/forms/settings";
import type { ParentFamilySpec } from "./parent";
import type { SeededSeason } from "./season";

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
  if (o.chosen?.length) await db.insert(requirementCover).values(o.chosen.map((subjectQboId) => ({ requirementId: row!.id, subjectQboId })));
  return row!.id;
}

export type SeedRequest = {
  requirementId: string; familyQboId: string; subjectQboId: string; state?: SignatureRequestState;
  envelopeId?: string | null; signers?: RequestSigner[]; subjectName?: string; form?: FormSetting;
  checkedAt?: Date | null; allSignedAt?: Date | null; sealAskedAt?: Date | null; evidenceOwed?: boolean;
};
/** One request as the portal would have left it in that state. Returns its id. */
export async function seedRequest(o: SeedRequest): Promise<string> {
  const state = o.state ?? "not_opened", has = state !== "not_opened";
  const now = new Date();
  const [row] = await db.insert(signatureRequest).values({
    requirementId: o.requirementId, familyQboId: o.familyQboId, subjectQboId: o.subjectQboId, state,
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

export const requestNow = async (id: string) => (await db.select().from(signatureRequest).where(eq(signatureRequest.id, id)))[0]!;

const signer = (parentId: string, name: string, email: string, recipientId: number, signedAt: string | null = null): RequestSigner => ({ parentId, recipientId, name, email, signedAt });

export type FamilyForms = {
  /** Strings that belong to this family's forms alone: its request ids, its documents' ids, a form asked only of it, its other guardian's name. */
  markers: string[];
  /** What this family's parent must find on the Forms page: each form's title and its state in words. */
  page: string[];
  /** The family's request in each state, by state; `waitingOther` is the one the other guardian has signed. */
  ids: Record<SignatureRequestState | "waitingOther", string>;
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
        signers: [me(), signer(crypto.randomUUID(), own.otherGuardian, `${tag}.other.guardian@forms.example`, 2, signedAt)] }),
    };
    return {
      ids,
      markers: [...Object.values(ids), ...["waiting", "signed", "complete", "declined", "other"].map((s) => `envelope_${tag}${s}`), own.title, ownRequirement, own.otherGuardian, `${tag}.other.guardian@forms.example`],
      page: ["Travel consent", own.title, "Uniform agreement", "Photo release", "Not signed yet", "Waiting for the other guardian", "Signed, being finished", "Signed", "Declined"],
    };
  };
  return {
    a: await one(a, "alderquist", { title: "Bus waiver QA74", otherGuardian: "Ottoline Alderquist-Voss" }),
    b: await one(b, "brackenmoor", { title: "Field trip waiver QB85", otherGuardian: "Benedikt Brackenmoor-Hale" }),
  };
}
