import { safeReturnPath } from "@/lib/auth/return-path";

/**
 * The code step, kept on the device while its code can still work (open question 29). A parent leaves the portal to
 * read the code in their mail; a phone may reload an installed app when they come back, and without this they would be
 * asked for their password again. Kept: when the first code was asked for (the right password), and the page they were
 * heading to. Not the address: since the sign-in release's slice SI-3b the server holds the person and the address in
 * the pending step (a signed cookie, src/lib/auth/parent-signin-step.ts), which ends CODE_TTL_MS after the right
 * password and is never extended. A resend doesn't change what is kept here, since a resent code ends with the step
 * (sendSecondStepCode()), so this lives as long as the step does. It is removed on sign-in and on "Start again", and
 * dropped once the step's life is over. Since slice SI-6a it keeps which second step it was too (`kind`): the emailed
 * code (`code`), or the parent's authenticator app (`app`), so a reload draws the same step; a step kept by an older
 * build, with no kind, is the code step.
 *
 * localStorage, not sessionStorage: an installed app that is reloaded starts a new session. No imports from the server
 * side: the sign-in form (a client component) uses this file.
 */
export const CODE_STEP_KEY = "booster.signin.code-step";
/** The pending step's life, and the longest a code lives (CODE_TTL_MS in src/lib/parents/signin-codes.ts; tests/unit/code-step.test.ts keeps the two equal). */
export const CODE_STEP_LIFE_MS = 10 * 60 * 1000;
/** Which second step: the emailed code, or the parent's authenticator app (its code, or a backup code). */
export type CodeStepKind = "code" | "app";
export type CodeStep = { sentAt: number; next: string | null; kind: CodeStepKind };
export type CodeStepStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The browser's store, or null where it is switched off (some private modes throw on touching it). */
export function deviceStore(): CodeStepStore | null {
  try { return window.localStorage; } catch { return null; }
}

export function saveCodeStep(store: CodeStepStore | null, step: CodeStep): void {
  try { store?.setItem(CODE_STEP_KEY, JSON.stringify(step)); } catch { /* a full or blocked store: the step is only not kept */ }
}

export function clearCodeStep(store: CodeStepStore | null): void {
  try { store?.removeItem(CODE_STEP_KEY); } catch { /* nothing to clear */ }
}

/**
 * The step to pick up, or null. What is stored is read as untrusted: anything but a time within the code's life is
 * removed, and the return path is checked again, like every other time it is read.
 */
export function loadCodeStep(store: CodeStepStore | null, now: number): CodeStep | null {
  try {
    const raw = store?.getItem(CODE_STEP_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { sentAt?: unknown; next?: unknown; kind?: unknown } | null;
    const live = typeof v === "object" && v !== null && typeof v.sentAt === "number" && Number.isFinite(v.sentAt) && v.sentAt <= now && now - v.sentAt < CODE_STEP_LIFE_MS;
    if (!live) { clearCodeStep(store); return null; }
    // Anything but the app's kind is the code step: a value of an older build, or one tampered with, draws nothing new.
    return { sentAt: v!.sentAt as number, next: safeReturnPath(v!.next), kind: v!.kind === "app" ? "app" : "code" };
  } catch {
    clearCodeStep(store);
    return null;
  }
}
