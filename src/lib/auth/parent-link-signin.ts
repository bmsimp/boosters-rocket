// A set-up link's sign-in, finished from the link form's server action (the sign-in release, slice SI-3a). Server
// only. A server action has no Better Auth endpoint of its own, and the one finish every sign-in goes through
// (finishParentSignin(), parent-signin-finish.ts) needs one, so the action reaches it through the parent code plugin's
// server-only endpoint (`finishLinkSignin`, parent-code-plugin.ts: it has no path, so the router serves it to nobody),
// and the cookie that endpoint sets is copied, as it was set, onto the action's answer. This is the one place that copy
// is made, with its pure part in session-cookie-copy.ts (tests/unit/one-way-in.test.ts).
import "server-only";
import { cookies, headers } from "next/headers";
import { cookiesToCopy } from "./session-cookie-copy";
import { stampClientIp } from "@/lib/request";
import type { LinkSignin } from "@/lib/parents/password-set";
import { getParentAuth } from "./parent-auth";

/**
 * Finishes the sign-in a set-up link's password was set for. Where to go once signed in, or null when the finish refused
 * it (the reason is in its `signin.refused` row) or anything failed: the password stays set either way, and the caller
 * answers as when nobody is signed in. The request's own headers go with it, stamped with the visitor's address
 * (stampClientIp(), as the session read stamps them), so the session records the address the code door's would. Each
 * cookie the finish set (the session's, and the expiry of a "don't remember me" cookie the browser held, if any) is set
 * on this answer with the same name, value and attributes.
 */
export async function signInFromLink(s: LinkSignin): Promise<string | null> {
  try {
    const auth = await getParentAuth();
    const { headers: set, response } = await auth.api.finishLinkSignin({
      body: { parentId: s.parentId, email: s.email, linkId: s.proof.linkId, credentialId: s.proof.credentialId, credentialUpdatedAt: s.proof.credentialUpdatedAt.getTime() },
      headers: stampClientIp(await headers()),
      returnHeaders: true,
    });
    if (!response.ok) return null;
    const jar = await cookies();
    for (const c of cookiesToCopy(set.getSetCookie())) jar.set(c.name, c.value, c.options);
    return response.next;
  } catch {
    return null;
  }
}
