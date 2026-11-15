import { safeReturnPath } from "@/lib/auth/return-path";

/**
 * The code step, kept on the device while its code can still work. A parent leaves the portal to read the code in
 * their mail; a phone may reload an installed app when they come back, and without this they would be asked for their
 * address again, and a second request inside a minute is refused. Kept: the address they typed, when the code was
 * asked for, and the page they were heading to. Nothing the portal knows about anyone: the page never learns whether
 * the address is on file. It is removed on sign-in and on "Use a different email", and dropped once the code's life
 * is over.
 *
 * localStorage, not sessionStorage: an installed app that is reloaded starts a new session. No imports from the server
 * side: the sign-in form (a client component) uses this file.
 */
export const CODE_STEP_KEY = "booster.signin.code-step";
/** The code's own life (CODE_TTL_MS in src/lib/parents/signin-codes.ts; tests/unit/code-step.test.ts keeps the two equal). */
export const CODE_STEP_LIFE_MS = 10 * 60 * 1000;
const MAX_EMAIL = 320;

export type CodeStep = { email: string; sentAt: number; next: string | null };
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
 * The step to pick up, or null. What is stored is read as untrusted: anything but an address and a time within the
 * code's life is removed, and the return path is checked again, like every other time it is read.
 */
export function loadCodeStep(store: CodeStepStore | null, now: number): CodeStep | null {
  try {
    const raw = store?.getItem(CODE_STEP_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { email?: unknown; sentAt?: unknown; next?: unknown } | null;
    const live = typeof v?.email === "string" && v.email.length > 0 && v.email.length <= MAX_EMAIL
      && typeof v.sentAt === "number" && Number.isFinite(v.sentAt) && v.sentAt <= now && now - v.sentAt < CODE_STEP_LIFE_MS;
    if (!live) { clearCodeStep(store); return null; }
    return { email: v.email as string, sentAt: v.sentAt as number, next: safeReturnPath(v.next) };
  } catch {
    clearCodeStep(store);
    return null;
  }
}
