"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { attachTemplate } from "@/lib/forms/attach";
import { isUuid } from "@/lib/seasons/ids";

// The form part of a requirement (v1 spec §9.1), beside the season actions in ./actions.ts and under the same
// permission as the rest of a season's set-up.
const SETUP = "Season.Steps.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };

/**
 * Attaches a Documenso template to a form requirement and says who must sign. Every argument comes from the browser:
 * each is checked here, and the library reads the template from Documenso and checks it before anything is saved.
 */
export const attachFormTemplateAction = staffAction(SETUP, async (ctx, requirementId: string, template: string, signers: "any" | "every"): Promise<Done> => {
  if (!isUuid(requirementId) || typeof template !== "string" || template.length > 500 || (signers !== "any" && signers !== "every")) return NOT_FROM_PAGE;
  const r = await attachTemplate(requirementId, { template, signers }, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: SETUP });
  if (!r.ok) return r;
  revalidatePath("/", "layout"); // parents see whether the form can be signed
  return { ok: true, message: r.setting.signers === "every" && r.setting.signerRoles === 1
    ? "Attached. The template has one signer, so one guardian signs each form."
    : "Attached. Parents can sign it now." };
});
