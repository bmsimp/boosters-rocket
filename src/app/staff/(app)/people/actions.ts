"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { inviteStaff, setStaffStatus } from "@/lib/staff/roles";

const actor = (c: { staffUserId: string; email: string }) => ({ door: "staff" as const, id: c.staffUserId, label: c.email });

export const inviteStaffAction = staffAction("Staff.Users.ReadWrite", async (ctx, form: FormData) => {
  const r = await inviteStaff({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") }, actor(ctx), ctx.ip);
  revalidatePath("/staff/people");
  return r;
});

export const setStaffStatusAction = staffAction("Staff.Users.ReadWrite", async (ctx, id: string, status: "active" | "disabled") => {
  const r = await setStaffStatus(id, status, actor(ctx), ctx.effective.isAdmin, ctx.ip); revalidatePath("/staff/people"); return r;
});
