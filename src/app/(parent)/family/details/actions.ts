"use server";
import { revalidatePath } from "next/cache";
import { parentAction } from "@/lib/guards";
import { saveMyContact } from "@/lib/parents/contact-edits";
import { CONTACT_FIELDS } from "@/lib/parents/contact-fields";

/**
 * Saves the signed-in parent's phone and mailing address to QuickBooks (v1 spec §6.2).
 *
 * `form` comes from the browser, whatever its type says. Only this form's own fields are read from it, each as
 * whatever it is, and saveMyContact() checks them: their type, their length, their characters. No field names a
 * customer, and none is looked for: whose record changes is decided from the session (ctx) alone, so an id sent along
 * in any field is never read.
 */
export const saveDetailsAction = parentAction(async (ctx, form: FormData) => {
  const sent = form as unknown;
  const field = (name: string): unknown => (sent instanceof FormData ? sent.get(name) : undefined);
  const input: Record<string, unknown> = { version: field("version") };
  for (const { name } of CONTACT_FIELDS) input[name] = field(name);
  const result = await saveMyContact(ctx, input);
  if (result.ok) {
    // The details box on Family and on Home shows the phone.
    revalidatePath("/family");
    revalidatePath("/");
  }
  return result;
});
