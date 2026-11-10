"use server";
import { redirect } from "next/navigation";
import { parentSessionAction } from "@/lib/guards";
import { chooseFamily } from "@/lib/parents/family-choice";

/** QuickBooks IDs are short; anything else from the client is refused like a family that isn't theirs. */
const MAX_FAMILY_ID = 64;
const usableFamilyId = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= MAX_FAMILY_ID ? v : null);

export const chooseFamilyAction = parentSessionAction(async (ctx, familyQboId: string) => {
  // The argument comes from the browser, whatever the type says.
  const ok = await chooseFamily({ sessionId: ctx.sessionId, parentId: ctx.parentId, familyQboId: usableFamilyId(familyQboId as unknown), ip: ctx.ip });
  redirect(ok ? "/" : "/choose-family");
});
