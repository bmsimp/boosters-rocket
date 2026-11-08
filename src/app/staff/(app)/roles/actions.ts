"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { saveRole, deleteRole, assignRole, unassignRole } from "@/lib/staff/roles";

const actor = (c: { staffUserId: string; email: string }) => ({ door: "staff" as const, id: c.staffUserId, label: c.email });
const lines = (v: FormDataEntryValue | null) => String(v ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

export const saveRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, form: FormData) => {
  const r = await saveRole({ id: String(form.get("id") ?? "") || undefined, name: String(form.get("name") ?? ""),
    include: lines(form.get("include")), exclude: lines(form.get("exclude")) }, actor(ctx), ctx.ip);
  revalidatePath("/staff/roles");
  return r;
});

export const deleteRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, id: string) => {
  const r = await deleteRole(id, actor(ctx), ctx.ip); revalidatePath("/staff/roles"); return r;
});

export const assignRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, roleId: string, staffUserId: string) => {
  const r = await assignRole(roleId, staffUserId, actor(ctx), ctx.ip); revalidatePath("/staff/people"); return r;
});

export const unassignRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, roleId: string, staffUserId: string) => {
  const r = await unassignRole(roleId, staffUserId, actor(ctx), ctx.ip); revalidatePath("/staff/people"); return r;
});
