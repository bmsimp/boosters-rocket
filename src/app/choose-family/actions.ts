"use server";
import { redirect } from "next/navigation";
import { parentSessionAction } from "@/lib/guards";
import { chooseFamily } from "@/lib/parents/family-choice";

export const chooseFamilyAction = parentSessionAction(async (ctx, familyQboId: string) => {
  const ok = await chooseFamily({ sessionId: ctx.sessionId, parentId: ctx.parentId, familyQboId, ip: ctx.ip });
  redirect(ok ? "/" : "/choose-family");
});
