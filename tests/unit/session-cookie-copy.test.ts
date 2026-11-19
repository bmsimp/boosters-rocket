import { describe, it, expect } from "vitest";
import { ResponseCookies } from "next/dist/compiled/@edge-runtime/cookies";
import { parseSetCookieHeader } from "better-auth/cookies";
import { cookiesToCopy } from "@/lib/auth/session-cookie-copy";

/**
 * The cookie a set-up link's sign-in copies onto the link form's answer (signInFromLink(), parent-link-signin.ts; the
 * sign-in release, slice SI-3a), as an https installation's finish sets it: the tests' own APP_URL is http, so their
 * sign-ins only ever see the plain name. Better Auth names the session cookie `__Secure-br_parent.session_token` there
 * and marks it Secure; a browser drops a `__Secure-` cookie set without Secure, and every set-up link would then stop
 * signing anyone in. Next's cookies() in a server action writes through ResponseCookies, as here.
 */
const NAME = "__Secure-br_parent.session_token";
/** A session token, a dot, and an HMAC-SHA256 signature in base64: `+`, `/` and `=` are all there. */
const SIGNED = "Zx9aQ2bT7mK4pR1sV8wY3cE6fH0jL5nB.q+Yz/8Ab3dE9kL+mN2pQ4rS6tU8vW0xY1zA3bC5dE/=";
/** 400 days, PARENT_SESSION_COOKIE_SECONDS (src/lib/parents/sessions.ts), the most a browser keeps a cookie. */
const MAX_AGE = 400 * 24 * 60 * 60;
/** As Better Auth (better-call's serializeSignedCookie) writes it: the signed value URL-encoded, then its attributes. */
const LINE = `${NAME}=${encodeURIComponent(SIGNED)}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;

describe("the copy of a sign-in's cookie at an https address", () => {
  it("reads the cookie with its name, its signed value and every attribute", () => {
    const [c, ...more] = cookiesToCopy([LINE]);
    expect(more).toEqual([]);
    expect(c!.name).toBe(NAME);
    expect(c!.value).toBe(SIGNED);
    expect(c!.options).toMatchObject({ maxAge: MAX_AGE, path: "/", httpOnly: true, secure: true, sameSite: "lax" });
  });

  it("is written by Next as Better Auth wrote it: the same name, the same bytes, the same attributes", () => {
    const headers = new Headers();
    const jar = new ResponseCookies(headers);
    for (const c of cookiesToCopy([LINE])) jar.set(c.name, c.value, c.options);
    const written = headers.getSetCookie();
    expect(written).toHaveLength(1);
    // The browser keeps the name and value exactly as the header carries them, and sends them back so.
    const pair = (line: string) => line.slice(0, line.indexOf(";"));
    expect(pair(written[0]!)).toBe(pair(LINE));
    // And Better Auth, reading the cookie back, decodes it to the value it signed.
    expect(decodeURIComponent(pair(written[0]!).slice(NAME.length + 1))).toBe(SIGNED);
    const before = parseSetCookieHeader(LINE).get(NAME)!, after = parseSetCookieHeader(written[0]!).get(NAME)!;
    for (const a of ["max-age", "path", "secure", "httponly", "samesite"] as const) expect(after[a], a).toEqual(before[a]);
    expect(after).toMatchObject({ "max-age": MAX_AGE, path: "/", secure: true, httponly: true, samesite: "lax" });
  });
});
