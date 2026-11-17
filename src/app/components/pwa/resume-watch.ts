/**
 * When to load fresh data in an app that was put away and brought back. An installed app has no reload button, and a
 * phone keeps its last screen for days: a balance paid from the laptop would still show as owed. Plain functions, no
 * component, so the rule is tested without a browser (tests/unit/pwa-resume.test.ts).
 */

/** Away for less than this, nothing happens: a glance at a text message is not worth a round trip. */
export const RESUME_AFTER_MS = 60_000;

type Doc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
type Win = Pick<Window, "addEventListener" | "removeEventListener">;

export type ResumeOptions = {
  afterMs?: number;
  doc?: Doc;
  win?: Win;
  now?: () => number;
  /** False when the device says it has no connection: a refresh then would only fail. */
  online?: () => boolean;
};

/**
 * Calls `refresh` when the page comes back to the front after being hidden for `afterMs` or longer. With no
 * connection at that moment, it waits and refreshes when the connection returns. Returns the function that stops it.
 */
export function watchResume(refresh: () => void, options: ResumeOptions = {}): () => void {
  const { afterMs = RESUME_AFTER_MS, doc = document, win = window, now = Date.now, online = () => navigator.onLine !== false } = options;
  let hiddenAt: number | null = doc.visibilityState === "hidden" ? now() : null;
  let owed = false; // a refresh that was due while there was no connection

  const refreshIfPossible = () => {
    if (!online()) { owed = true; return; }
    owed = false;
    refresh();
  };
  const cameBack = () => {
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (away >= afterMs || owed) refreshIfPossible();
  };
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") hiddenAt ??= now();
    else cameBack();
  };
  // A page brought back whole from the browser's back-forward store: some browsers say so only here.
  const onPageShow = (e: Event) => { if ((e as PageTransitionEvent).persisted && doc.visibilityState !== "hidden") cameBack(); };
  const onOnline = () => { if (owed && doc.visibilityState !== "hidden") refreshIfPossible(); };

  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pageshow", onPageShow);
  win.addEventListener("online", onOnline);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pageshow", onPageShow);
    win.removeEventListener("online", onOnline);
  };
}
