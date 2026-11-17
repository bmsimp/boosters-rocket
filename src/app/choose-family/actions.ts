"use server";
import { redirect } from "next/navigation";
import { parentSessionAction } from "@/lib/guards";
import { chooseFamily } from "@/lib/parents/family-choice";
import { landingPath, withReturnPath } from "@/lib/auth/return-path";

/** QuickBooks IDs are short; anything else from the client is refused like a family that isn't theirs. */
const MAX_FAMILY_ID = 64;
const usableFamilyId = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= MAX_FAMILY_ID ? v : null);

/**
 * `next` is the page the parent asked for before they had to choose (requireParentPage). Both arguments come from the
 * browser, whatever the types say: the family is checked against the person's own links (chooseFamily), and `next` is
 * only ever used through landingPath() and withReturnPath(), which drop anything that is not a parent page of this site.
 */
export const chooseFamilyAction = parentSessionAction(async (ctx, familyQboId: string, next?: string) => {
  const ok = await chooseFamily({ sessionId: ctx.sessionId, parentId: ctx.parentId, familyQboId: usableFamilyId(familyQboId as unknown), ip: ctx.ip });
  redirect(ok ? landingPath(next as unknown) : withReturnPath("/choose-family", next as unknown));
});
