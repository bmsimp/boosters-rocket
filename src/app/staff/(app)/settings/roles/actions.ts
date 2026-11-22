"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { saveRole, deleteRole } from "@/lib/staff/roles";
import { rulesFromChecklist } from "@/lib/permissions/checklist";

const P = "Admin.Roles.ReadWrite" as const;
const actor = (c: { staffUserId: string; email: string }) => ({ door: "staff" as const, id: c.staffUserId, label: c.email });
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
// A server action can be called with any values: each is checked for type and size before the library sees it.
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Saves a role from the checklist: its name and the permissions ticked, written as include rules of their exact names
 * (rulesFromChecklist). `id` is null for a new role. A role that held patterns holds plain names after this.
 */
export const saveRoleChecklistAction = staffAction(P, async (ctx, id: unknown, name: unknown, ticked: unknown): Promise<Done> => {
  if ((id !== null && (typeof id !== "string" || !UUID.test(id))) || typeof name !== "string" || name.length > 200 || !Array.isArray(ticked)) return NOT_FROM_PAGE;
  const rules = rulesFromChecklist(ticked);
  if (!rules.ok) return rules;
  const r = await saveRole({ id: id ?? undefined, name, include: rules.rules.include, exclude: [] }, actor(ctx), ctx.ip);
  if (!r.ok) return r;
  revalidatePath("/staff/settings/roles");
  revalidatePath("/staff/settings/staff");
  return { ok: true, message: id ? "Saved." : "Role made." };
});

/** Deletes a role. The people who held it keep their other roles. The built-in Admin role can't be deleted. */
export const deleteRoleAction = staffAction(P, async (ctx, id: unknown): Promise<Done> => {
  if (typeof id !== "string" || !UUID.test(id)) return NOT_FROM_PAGE;
  const r = await deleteRole(id, actor(ctx), ctx.ip);
  if (!r.ok) return { ok: false, errors: [r.error ?? "That didn't go through."] };
  revalidatePath("/staff/settings/roles");
  revalidatePath("/staff/settings/staff");
  return { ok: true, message: "Deleted." };
});
