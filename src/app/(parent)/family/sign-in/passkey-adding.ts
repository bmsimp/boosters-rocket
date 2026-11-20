/**
 * The browser side of adding a passkey and of asking again with one (the sign-in release, slice SI-7b): the passkey
 * library's own ceremonies (parentAuthClient.passkey.addPasskey() and signIn.passkey(), @better-auth/passkey/client,
 * which ask for the options and run the browser's passkey prompt), each with its one verify request sent to the
 * portal's own endpoint instead of the library's verify path, which is disabled over HTTP: /portal-passkey/add for an
 * add, /portal-passkey/again for asking again. The request is turned by better-fetch's `onRequest` hook, as the
 * sign-in page's is (toPortalCheck(), src/app/sign-in/passkey-ceremony.ts). For an add the hook also puts the typed
 * name in the body beside the library's answer, so the name never goes to the library's options (whose `name` query
 * would become the passkey's user name in a password manager, in place of the parent's sign-in address) and is never
 * given to addPasskey() itself. No imports, so the forms (client components) and a unit test read the same code; it
 * holds no secret and is given only the page's own origin and the name typed.
 */

/** The portal's own add, under the parent door's base path. */
export const PASSKEY_ADD_PATH = "/api/auth/parent/portal-passkey/add";
/** The portal's own asking again with a passkey, under the parent door's base path. */
export const PASSKEY_AGAIN_PATH = "/api/auth/parent/portal-passkey/again";

/** The add's body: the library's answer ({ response }, as its ceremony serialized it), and the name when one was typed. */
export function addBody(libraryBody: unknown, name: string): string {
  let response: unknown = null;
  if (typeof libraryBody === "string") {
    try { response = (JSON.parse(libraryBody) as { response?: unknown }).response ?? null; } catch { response = null; }
  }
  const trimmed = name.trim();
  return JSON.stringify(trimmed ? { response, name: trimmed } : { response });
}

/**
 * The `fetchOptions` the library's add spreads into its verify request: an `onRequest` hook that sends it to the
 * portal's add on this page's origin, with the body rebuilt by addBody(). Nothing else of the request changes.
 */
export function toPortalAdd(origin: string, name: string) {
  return { onRequest: <C extends { url: URL | string; body?: unknown }>(context: C): C => ({ ...context, url: new URL(PASSKEY_ADD_PATH, origin), body: addBody(context.body, name) }) };
}

/** The `fetchOptions` the library's sign-in ceremony spreads into its verify request, sent to the portal's asking again. */
export function toPortalAgain(origin: string) {
  return { onRequest: <C extends { url: URL | string }>(context: C): C => ({ ...context, url: new URL(PASSKEY_AGAIN_PATH, origin) }) };
}

/** Whether this browser can make a passkey at all: WebAuthn's credential interface and its create(). */
export function passkeysAddIn(w: { PublicKeyCredential?: unknown; navigator?: { credentials?: { create?: unknown } } }): boolean {
  return typeof w.PublicKeyCredential === "function" && typeof w.navigator?.credentials?.create === "function";
}
