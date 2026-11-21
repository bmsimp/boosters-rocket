// What a set-up link's sign-in copies onto a server action's answer (parent-link-signin.ts; the sign-in release, slice
// SI-3a): the cookies a `Set-Cookie` header of the finish sets, each as Next's cookies().set() takes it. Pure, so the copy
// is tested as an https installation's cookie comes (tests/unit/session-cookie-copy.test.ts): the `__Secure-` name,
// `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, the long `Max-Age` and a signed value.
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";

/** One cookie to set: its name, its value as the browser is to hold it once Next has written it, and its attributes. */
export type CookieToSet = { name: string; value: string; options: ReturnType<typeof toCookieOptions> };

/**
 * The cookies the `Set-Cookie` lines set, with the same name, value and attributes. Better Auth writes a value
 * URL-encoded (a signature holds `+`, `/` and `=`); it is read back decoded here, and Next's cookies().set() encodes it
 * again as it writes the header, so the browser holds the very bytes Better Auth wrote.
 */
export function cookiesToCopy(setCookie: string[]): CookieToSet[] {
  const out: CookieToSet[] = [];
  for (const line of setCookie) {
    for (const [name, attributes] of parseSetCookieHeader(line)) out.push({ name, value: attributes.value, options: toCookieOptions(attributes) });
  }
  return out;
}
