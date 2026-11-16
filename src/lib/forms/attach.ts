// Staff attach a Documenso template to a form requirement and say who must sign (v1 spec §9.1). The portal reads the
// template and refuses it, in plain words, unless documents can safely be made from it (./template.ts). One
// transaction with its audit row. Reads no family's data.
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, type FormSetting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { DOCUMENSO_ERRORS, envelopeIdIn, getEnvelope, listTemplates } from "@/lib/documenso/client";
import { asking } from "./requests";
import { getFormsConfig } from "./settings";
import { checkTemplate } from "./template";

export type AttachOp = { actor: Actor; ip: string | null; permission?: string };
type Done<T = object> = ({ ok: true } & T) | { ok: false; errors: string[] };
export const SETUP_FIRST = "Forms aren't set up yet. An Admin connects the club's Documenso under Forms settings; then a template can be attached.";
const GONE = "That isn't there any more. Reload the page.";

/** The templates Documenso has, for staff to pick from; null when forms aren't set up or Documenso can't be asked. */
export async function templateChoices(): Promise<{ id: string; title: string }[] | null> {
  const config = await getFormsConfig();
  if (!config) return null;
  const list = await asking(() => listTemplates(config));
  return list.ok ? list.value : null;
}

/** The form part of a requirement, for its staff page: null for a requirement that isn't a form, `setting` null until a template is attached. */
export async function formSettingOf(requirementId: string): Promise<{ setting: FormSetting | null } | null> {
  const [r] = await db.select({ kind: requirement.kind, form: requirement.form }).from(requirement).where(eq(requirement.id, requirementId));
  return r && r.kind === "form" ? { setting: r.form ?? null } : null;
}

/**
 * Attaches a template to a form requirement, or replaces the one it has. `template` is what staff picked or pasted:
 * the template's id, or the address of its page in Documenso. Documents already signed by someone stay as they are;
 * one nobody has signed is made again from the new template the next time a guardian opens it.
 */
export async function attachTemplate(requirementId: string, input: { template: string; signers: "any" | "every" }, o: AttachOp): Promise<Done<{ setting: FormSetting }>> {
  const [found] = await db.select().from(requirement).where(eq(requirement.id, requirementId));
  if (!found) return { ok: false, errors: [GONE] };
  if (found.kind !== "form") return { ok: false, errors: ["Only a form requirement has a template."] };
  const config = await getFormsConfig();
  if (!config) return { ok: false, errors: [SETUP_FIRST] };
  const templateId = envelopeIdIn(input.template);
  if (!templateId) return { ok: false, errors: ["Choose a template, or paste the address of the template's page in Documenso (it holds an id that starts with envelope_)."] };
  const read = await asking(() => getEnvelope(config, templateId));
  if (!read.ok) return { ok: false, errors: [read.code === "not_found" ? "Documenso has no template with that id. Open the template in Documenso and copy its address again."
    : `The template couldn't be read. ${read.code === "unexpected" ? "" : DOCUMENSO_ERRORS[read.code]}`.trim()] };
  const check = checkTemplate(read.value, found.appliesTo);
  if (!check.ok) return { ok: false, errors: check.errors };
  const setting: FormSetting = { templateId: check.plan.templateId, templateTitle: check.plan.title.slice(0, 200), templateUpdatedAt: check.plan.updatedAt,
    signerRoles: check.plan.signers.length === 2 ? 2 : 1, signers: input.signers, attachedAt: new Date().toISOString() };
  return db.transaction(async (tx): Promise<Done<{ setting: FormSetting }>> => {
    const [r] = await tx.select().from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r || r.kind !== "form") return { ok: false, errors: [GONE] };
    await tx.update(requirement).set({ form: setting, updatedAt: new Date() }).where(eq(requirement.id, r.id));
    const said = (f: FormSetting | null) => (f ? { templateId: f.templateId, templateTitle: f.templateTitle, templateUpdatedAt: f.templateUpdatedAt, signerRoles: f.signerRoles, signers: f.signers } : null);
    await writeAudit({ actor: o.actor, action: "season.requirement.form.attach", permission: o.permission, targetType: "requirement", targetId: r.id, ip: o.ip,
      before: { title: r.title, form: said(r.form ?? null) }, after: { title: r.title, form: said(setting) } }, tx);
    return { ok: true, setting };
  });
}
