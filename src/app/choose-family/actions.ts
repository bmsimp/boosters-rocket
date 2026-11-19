"use server";
import { redirect } from "next/navigation";
import { parentSessionAction } from "@/lib/guards";
import { chooseFamily } from "@/lib/parents/family-choice";
import { landingPath, withReturnPath } from "@/lib/auth/return-path";

/** A guardian row's id is a uuid; anything else from the client is refused like a row that isn't theirs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const usableGuardianId = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);
/** A short string that isn't a row's id (another family's QuickBooks id, say) is still recorded on the refusal; anything longer, or not a string, is not. */
const MAX_RECORDED = 64;
const recordable = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= MAX_RECORDED ? v : undefined);

/**
 * The chooser binds the person's own guardian row, never a family's QuickBooks id. `next` is the page the parent asked
 * for before they had to choose (requireParentPage). Both arguments come from the browser, whatever the types say: the
 * row is checked against the person's own open rows (chooseFamily), and `next` is only ever used through landingPath()
 * and withReturnPath(), which drop anything that is not a parent page of this site.
 */
export const chooseFamilyAction = parentSessionAction(async (ctx, guardianId: string, next?: string) => {
  const usable = usableGuardianId(guardianId as unknown);
  const ok = await chooseFamily({ sessionId: ctx.sessionId, parentId: ctx.parentId, guardianId: usable,
    sent: usable === null ? recordable(guardianId as unknown) : undefined, ip: ctx.ip });
  redirect(ok ? landingPath(next as unknown) : withReturnPath("/choose-family", next as unknown));
});
