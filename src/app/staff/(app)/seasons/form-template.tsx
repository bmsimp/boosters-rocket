import { formSettingOf, templateChoices } from "@/lib/forms/attach";
import { getFormsConfig } from "@/lib/forms/settings";
import { SUBJECT_LABEL, guardianLabel } from "@/lib/forms/template";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { attachFormTemplateAction } from "./form-actions";
import { FormTemplateForm } from "./form-template-form";

/**
 * The form part of a requirement's page (v1 spec §9.1): the Documenso template attached to it and who must sign, and
 * for staff who may change the season, the way to attach one. Nothing for a requirement of another kind. It reads no
 * family's data. The template's name is Documenso's text, written as text only.
 */
export async function FormTemplateBox({ requirementId, appliesTo, canChange }: { requirementId: string; appliesTo: "family" | "student"; canChange: boolean }) {
  const form = await formSettingOf(requirementId);
  if (!form) return null;
  const { setting } = form;
  const ready = (await getFormsConfig()) !== null;
  // Documenso is asked for its templates only for someone who can attach one.
  const choices = canChange && ready ? await templateChoices() : null;
  return (
    <section className="box" aria-labelledby="form-template-h"><h2 id="form-template-h">The form to sign</h2>
      {setting ? (
        <dl className="details">
          <dt>Template</dt><dd>{setting.templateTitle || setting.templateId}</dd>
          <dt>Who signs</dt><dd>{setting.signers === "any" ? "Any one guardian"
            : setting.signerRoles === 1 ? "Every guardian was chosen, and the template has one signer: one guardian signs" : "Every guardian who has a sign-in, up to two"}</dd>
          <dt>Attached</dt><dd><LocalTime iso={setting.attachedAt} /></dd>
          <dt>Last changed in Documenso</dt><dd><LocalTime iso={setting.templateUpdatedAt} />, when it was attached</dd>
        </dl>
      ) : <p>No template is attached yet, so parents read that this form isn&apos;t ready.</p>}
      <p className="hint">Have the club&apos;s lawyer read the form&apos;s words before families sign it. The portal checks the template&apos;s fields, not what it says, and gives no legal advice.</p>
      {!ready && <Notice tone="info">Forms aren&apos;t set up yet. An Admin connects the club&apos;s Documenso under <a href="/staff/settings/forms">Forms settings</a>; then a template can be attached.</Notice>}
      {canChange && ready && (
        // Folded like the page's other forms, and left to the browser to open and close: drawn again after a
        // template is attached, it stays open, with what the action said still on the screen.
        <details className="more"><summary>{setting ? "Attach another template, or change who signs" : "Attach a template"}</summary>
          <p className="hint">Make the form as a Documenso template first, with: one or two signers;
            {appliesTo === "student" ? <> a text field labelled <b>{SUBJECT_LABEL.student}</b> for the first signer;</> : <> if the family is named on it, a text field labelled <b>{SUBJECT_LABEL.family}</b> for the first signer;</>}
            {" "}a text field labelled <b>{guardianLabel(1)}</b> for the first signer (<b>{guardianLabel(2)}</b> for the second); and a signature field for each.
            Set every name field to Read only, or a signer could change a name.</p>
          {choices === null && <p className="hint">Documenso&apos;s templates couldn&apos;t be listed just now. Paste the address of the template&apos;s page instead.</p>}
          <FormTemplateForm choices={choices} current={setting?.templateId ?? null} signers={setting?.signers ?? "any"} save={attachFormTemplateAction.bind(null, requirementId)} />
          {setting && <p className="hint">Signed forms stay as they are. Unsigned ones use the new template next time a guardian opens them.</p>}
        </details>
      )}
    </section>
  );
}
