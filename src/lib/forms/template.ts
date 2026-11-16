/**
 * What the portal needs of a Documenso template before it will make documents from it (v1 spec §9.1; verification
 * report, section 1a "what the report missed" and section 5 point 1). Pure: it reads the envelope the client fetched
 * and answers in sentences staff can act on in Documenso's editor.
 *
 * The portal fills in names, and a signer holds a token that can change any field that is not read-only: so every
 * field the portal fills must be read-only, or a guardian could put another student's name on a signed form.
 */
import type { Envelope, EnvelopeField, EnvelopeRecipient } from "@/lib/documenso/client";

/** The labels staff give the text fields in Documenso's editor. Matched without regard to case or spacing. */
export const SUBJECT_LABEL = { student: "Student name", family: "Family name" } as const;
export const guardianLabel = (n: number) => `Guardian ${n} name`;
/** A template has one or two guardians who sign. */
export const MAX_SIGNER_ROLES = 2;

const norm = (label: string | null) => (label ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const GUARDIAN_LABEL = /^guardian (\d+) name$/;

/** One guardian's place in the template: the recipient to fill, and the fields that take their name. */
export type SignerRole = { recipientId: number; nameFieldIds: number[] };
export type TemplatePlan = {
  templateId: string; title: string; updatedAt: string;
  /** In signing order: the first guardian, then the second when the template has one. */
  signers: SignerRole[];
  /** The fields that take the student's name (or the family's, for a form asked once of each family). */
  subjectFieldIds: number[];
};
export type TemplateCheck = { ok: true; plan: TemplatePlan } | { ok: false; errors: string[] };

const bySigningOrder = (a: EnvelopeRecipient, b: EnvelopeRecipient) => (a.signingOrder ?? Number.MAX_SAFE_INTEGER) - (b.signingOrder ?? Number.MAX_SAFE_INTEGER) || a.id - b.id;

/**
 * Whether documents can be made from this template for a requirement asked of each student or each family, and if so
 * which recipient and which fields are which. Every problem is listed at once, so staff can mend them in one visit.
 */
export function checkTemplate(envelope: Envelope, appliesTo: "family" | "student"): TemplateCheck {
  const errors: string[] = [];
  if (envelope.type !== "TEMPLATE") return { ok: false, errors: ["That is a document, not a template. In Documenso, open Templates and choose one from there."] };

  const others = envelope.recipients.filter((r) => r.role !== "SIGNER");
  if (others.length > 0) errors.push("Every recipient of the template must be a signer. Remove the recipients who only approve, view or get a copy: the portal fills in guardians and nobody else.");
  const signers = envelope.recipients.filter((r) => r.role === "SIGNER").sort(bySigningOrder);
  if (signers.length === 0) errors.push("The template has no signer. Add one or two recipients with the role Signer: one for each guardian who signs.");
  if (signers.length > MAX_SIGNER_ROLES) errors.push(`The template has ${signers.length} signers. The portal fills in one or two guardians: remove the others.`);
  if (errors.length > 0) return { ok: false, errors };

  const fieldsOf = (recipientId: number) => envelope.fields.filter((f) => f.recipientId === recipientId);
  const labelled = (label: string) => envelope.fields.filter((f) => norm(f.label) === norm(label));
  const filled: EnvelopeField[] = [];

  const subjectLabel = SUBJECT_LABEL[appliesTo], otherLabel = SUBJECT_LABEL[appliesTo === "student" ? "family" : "student"];
  const subjectFields = labelled(subjectLabel);
  if (appliesTo === "student" && subjectFields.length === 0) {
    errors.push(`The template has no field labelled "${subjectLabel}". Add a text field with that label for the first signer, and make it read-only: the portal fills in the student's name.`);
  }
  if (labelled(otherLabel).length > 0) {
    errors.push(appliesTo === "student"
      ? `The template has a field labelled "${otherLabel}", and this form is signed once for each student. Label it "${subjectLabel}", or remove it.`
      : `The template has a field labelled "${otherLabel}", and this form is signed once for each family, so the portal has no student to name. Label it "${subjectLabel}", or remove it.`);
  }
  // On the first signer, so the field is still there when the second signer is removed from a one-guardian document.
  if (subjectFields.some((f) => f.recipientId !== signers[0]!.id)) errors.push(`The field labelled "${subjectLabel}" must belong to the first signer.`);
  filled.push(...subjectFields);

  const roles: SignerRole[] = signers.map((signer, i) => {
    const label = guardianLabel(i + 1), own = fieldsOf(signer.id);
    const names = labelled(label);
    if (names.length === 0) errors.push(`The template has no field labelled "${label}". Add a text field with that label for signer ${i + 1}, and make it read-only: the portal fills in the guardian's name.`);
    if (names.some((f) => f.recipientId !== signer.id)) errors.push(`The field labelled "${label}" must belong to signer ${i + 1}, so it goes with them.`);
    if (!own.some((f) => f.type === "SIGNATURE")) errors.push(`Signer ${i + 1} has no signature field. Add one for them.`);
    filled.push(...names);
    return { recipientId: signer.id, nameFieldIds: names.map((f) => f.id) };
  });
  // A name field for a guardian the template has no signer for would be left empty on every document.
  for (const f of envelope.fields) {
    const n = Number(GUARDIAN_LABEL.exec(norm(f.label))?.[1] ?? 0);
    if (n > signers.length) { errors.push(`The template has a field labelled "${guardianLabel(n)}" and ${signers.length === 1 ? "only one signer" : `only ${signers.length} signers`}. Remove the field, or add the signer.`); break; }
  }

  if (filled.some((f) => f.type !== "TEXT")) errors.push("The fields the portal fills in (the student's and guardians' names) must be text fields.");
  const open = [...new Set(filled.filter((f) => !f.readOnly).map((f) => (f.label ?? "").trim()))];
  if (open.length > 0) {
    errors.push(`${open.length === 1 ? `The field "${open[0]}" is` : `These fields are`} not read-only${open.length === 1 ? "" : `: ${open.map((l) => `"${l}"`).join(", ")}`}. `
      + `A signer could change a name on the form. In Documenso's editor, open each field's settings and switch on Read only.`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: { templateId: envelope.id, title: envelope.title, updatedAt: envelope.updatedAt, signers: roles, subjectFieldIds: subjectFields.map((f) => f.id) } };
}
