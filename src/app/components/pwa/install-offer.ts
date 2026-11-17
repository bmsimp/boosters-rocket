/**
 * Chromium's install offer, kept for the install hint. The browser fires "beforeinstallprompt" once, soon after a page
 * loads, and only that event can open its install prompt. The hint may be drawn much later (on the Display page, after
 * moving between pages), so the event is caught here, from the root layout (app-install.tsx), and held.
 *
 * The event is not cancelled: the browser's own install button and banner stay as they are.
 */
export type InstallOfferEvent = Event & {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Target = Pick<EventTarget, "addEventListener">;

let offer: InstallOfferEvent | null = null;
let installedNow = false;
let watched: Target | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const listener of listeners) listener(); };

/** Start listening, once. Safe to call from every module that needs the offer. */
export function watchInstallOffer(target: Target | undefined = typeof window === "undefined" ? undefined : window): void {
  if (!target || watched === target) return;
  watched = target;
  target.addEventListener("beforeinstallprompt", (e) => { offer = e as InstallOfferEvent; tell(); });
  target.addEventListener("appinstalled", () => { offer = null; installedNow = true; tell(); });
}

export function subscribeInstallOffer(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The offer, or null when the browser has made none (or it was used). */
export const installOffer = () => offer;

/** True once the browser says the portal was installed during this visit. */
export const installedThisVisit = () => installedNow;

let asking = false;

/** Opens the browser's install prompt. An offer can be used once, so it is dropped whatever the person chooses. */
export async function openInstallPrompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = offer;
  if (!event || asking) return "unavailable";
  asking = true;
  try {
    await event.prompt();
    return (await event.userChoice).outcome;
  } catch {
    return "unavailable";
  } finally {
    asking = false;
    if (offer === event) offer = null;
    tell();
  }
}
