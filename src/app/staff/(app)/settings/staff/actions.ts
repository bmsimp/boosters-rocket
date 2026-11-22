"use server";
import { revalidatePath } from "next/cache";
import { staffAction, staffSelfAction } from "@/lib/guards";
import { inviteStaff, setStaffStatus, setStaffRoles } from "@/lib/staff/roles";
import { renameStaff } from "@/lib/staff/names";

const actor = (c: { staffUserId: string; email: string }) => ({ door: "staff" as const, id: c.staffUserId, label: c.email });
const roleIds = (form: FormData) => form.getAll("roleIds").map(String);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FROM_PAGE = { ok: false as const, errors: ["That didn't go through. Reload the page and try again."] };

export const inviteStaffAction = staffAction("Staff.Users.ReadWrite", async (ctx, form: FormData) => {
  const r = await inviteStaff({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") }, roleIds(form),
    { actor: actor(ctx), ip: ctx.ip });
  revalidatePath("/staff/settings/staff");
  return r;
});

export const setStaffRolesAction = staffAction("Staff.Users.ReadWrite", async (ctx, staffUserId: string, form: FormData) => {
  const r = await setStaffRoles(staffUserId, roleIds(form),
    { actor: actor(ctx), actorStaffUserId: ctx.staffUserId, ip: ctx.ip });
  revalidatePath("/staff/settings/staff");
  return r;
});

export const setStaffStatusAction = staffAction("Staff.Users.ReadWrite", async (ctx, id: string, status: "active" | "disabled") => {
  const r = await setStaffStatus(id, status, actor(ctx), ctx.ip); revalidatePath("/staff/settings/staff"); return r;
});

/** Anyone's name, for someone who manages staff. */
export const renameStaffAction = staffAction("Staff.Users.ReadWrite", async (ctx, id: unknown, name: unknown) => {
  if (typeof id !== "string" || !UUID.test(id)) return NOT_FROM_PAGE;
  const r = await renameStaff(id, name, { actor: actor(ctx), ip: ctx.ip, permission: "Staff.Users.ReadWrite" });
  revalidatePath("/staff", "layout"); // the bar's initials and the staff home's greeting use the name
  return r;
});

/** A staff member's own name, whatever they may do otherwise. It takes no id: the record is the session's own. */
export const renameMyselfAction = staffSelfAction(async (ctx, name: unknown) => {
  const r = await renameStaff(ctx.staffUserId, name, { actor: actor(ctx), ip: ctx.ip, permission: null });
  revalidatePath("/staff", "layout");
  return r;
});
