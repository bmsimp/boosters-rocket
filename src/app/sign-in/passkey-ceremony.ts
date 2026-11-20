/**
 * The browser side of a passkey's sign-in (the sign-in release, slice SI-7a): the passkey library's own ceremony
 * (parentAuthClient.signIn.passkey(), @better-auth/passkey/client, which asks for the challenge and runs the browser's
 * passkey prompt), with its one verify request sent to the portal's own check, /portal-passkey/check, instead of the
 * library's verify path, which is disabled and makes a session itself. The request is turned by better-fetch's
 * `onRequest` hook (toPortalCheck()), which keeps the body the library builds ({ response }) and puts `next` in the
 * query string. No imports, so the sign-in form (a client component) and a unit test read the same code; it holds no
 * secret and is given only the page's own origin and where to go.
 */

/** The portal's own passkey check, under the parent door's base path. */
export const PASSKEY_CHECK_PATH = "/api/auth/parent/portal-passkey/check";

/** The address of the portal's check, on this page's origin, with the page to go to (`next`) when there is one. */
export function portalCheckUrl(origin: string, next: string | null): URL {
  const url = new URL(PASSKEY_CHECK_PATH, origin);
  if (next) url.searchParams.set("next", next);
  return url;
}

/**
 * The `fetchOptions` the library's ceremony spreads into its verify request: an `onRequest` hook that sends it to the
 * portal's check. Nothing else of the request changes.
 */
export function toPortalCheck(origin: string, next: string | null) {
  return { onRequest: <C extends { url: URL | string }>(context: C): C => ({ ...context, url: portalCheckUrl(origin, next) }) };
}

/** Whether this browser can run a passkey's ceremony at all: WebAuthn's credential interface and its get(). */
export function passkeysWorkIn(w: { PublicKeyCredential?: unknown; navigator?: { credentials?: { get?: unknown } } }): boolean {
  return typeof w.PublicKeyCredential === "function" && typeof w.navigator?.credentials?.get === "function";
}

/** What the ceremony came to: the portal's answer, the person cancelling (or the browser refusing), or no answer to read. */
export type CeremonyOutcome<T> = { kind: "answer"; body: T } | { kind: "cancelled" } | { kind: "failed"; status: number | null };

/**
 * Reads what the library's ceremony answered. Its own words for a cancel or the browser's refusal (a NotAllowedError
 * comes back as its `AUTH_CANCELLED`, or as one of @simplewebauthn/browser's `ERROR_` codes) are a cancel, said in words
 * and never thrown; an answer from the portal's check (always a 200 with `ok`) is the answer; anything else (the
 * challenge not reached, the portal turning the browser away with a 429) failed, with its status.
 */
export function readCeremony<T>(r: { data?: unknown; error?: { code?: unknown; status?: unknown } | null } | null | undefined): CeremonyOutcome<T> {
  const error = r?.error;
  if (error) {
    const code = typeof error.code === "string" ? error.code : "";
    if (code === "AUTH_CANCELLED" || code.startsWith("ERROR_")) return { kind: "cancelled" };
    return { kind: "failed", status: typeof error.status === "number" ? error.status : null };
  }
  const body = r?.data;
  if (typeof body === "object" && body !== null && "ok" in body) return { kind: "answer", body: body as T };
  return { kind: "failed", status: null };
}
