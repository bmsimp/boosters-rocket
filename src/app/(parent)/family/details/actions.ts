"use server";
import { revalidatePath } from "next/cache";
import { parentAction } from "@/lib/guards";
import { saveMyContact } from "@/lib/parents/contact-edits";
import { CONTACT_FIELDS } from "@/lib/parents/contact-fields";

/**
 * Saves the signed-in parent's phone and mailing address in the portal (v1 spec §6.2): their own, or their family's in
 * books with no parent type.
 *
 * `form` comes from the browser, whatever its type says. Only this form's own fields are read from it, each as
 * whatever it is, and saveMyContact() checks them: their type, their length, their characters. No field names a
 * person, family or customer, and none is looked for: whose details change is decided from the session (ctx) alone, so an id sent along
 * in any field is never read.
 *
 * After a save, the pages that show these details are revalidated: this one, and Family and Home for the phone in
 * the details box. The server caches none of them (each is rendered from the session), but the browser's router keeps
 * the pages it has visited, and without this the Back button could bring up this form with the values from before
 * the save. Revalidating also makes Next.js draw this page again as the answer comes back; DetailsEditor keeps the
 * form and its "Saved" on the screen as they were.
 */
export const saveDetailsAction = parentAction(async (ctx, form: FormData) => {
  const sent = form as unknown;
  const field = (name: string): unknown => (sent instanceof FormData ? sent.get(name) : undefined);
  const input: Record<string, unknown> = { version: field("version") };
  for (const { name } of CONTACT_FIELDS) input[name] = field(name);
  const result = await saveMyContact(ctx, input);
  if (result.ok) for (const path of ["/family/details", "/family", "/"]) revalidatePath(path);
  return result;
});
