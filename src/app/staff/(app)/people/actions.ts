"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { inviteStaff, setStaffStatus, setStaffRoles } from "@/lib/staff/roles";

const actor = (c: { staffUserId: string; email: string }) => ({ door: "staff" as const, id: c.staffUserId, label: c.email });
const roleIds = (form: FormData) => form.getAll("roleIds").map(String);

export const inviteStaffAction = staffAction("Staff.Users.ReadWrite", async (ctx, form: FormData) => {
  const r = await inviteStaff({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") }, roleIds(form),
    { actor: actor(ctx), actorIsAdmin: ctx.effective.isAdmin, ip: ctx.ip });
  revalidatePath("/staff/people");
  return r;
});

export const setStaffRolesAction = staffAction("Staff.Users.ReadWrite", async (ctx, staffUserId: string, form: FormData) => {
  const r = await setStaffRoles(staffUserId, roleIds(form),
    { actor: actor(ctx), actorStaffUserId: ctx.staffUserId, actorIsAdmin: ctx.effective.isAdmin, ip: ctx.ip });
  revalidatePath("/staff/people");
  return r;
});

export const setStaffStatusAction = staffAction("Staff.Users.ReadWrite", async (ctx, id: string, status: "active" | "disabled") => {
  const r = await setStaffStatus(id, status, actor(ctx), ctx.effective.isAdmin, ctx.ip); revalidatePath("/staff/people"); return r;
});
