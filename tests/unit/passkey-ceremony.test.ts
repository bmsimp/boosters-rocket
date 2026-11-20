import { describe, it, expect } from "vitest";
import { PASSKEY_CHECK_PATH, passkeysWorkIn, portalCheckUrl, readCeremony, toPortalCheck } from "@/app/sign-in/passkey-ceremony";

/**
 * The browser side of a passkey's sign-in (the sign-in release, slice SI-7a): the passkey library's ceremony, with its
 * one verify request sent to the portal's own check, never to the library's verify path.
 */
describe("the verify request goes to the portal's own check", () => {
  it("is the portal's path on the page's own origin, with next in the query string only when there is one", () => {
    expect(PASSKEY_CHECK_PATH).toBe("/api/auth/parent/portal-passkey/check");
    expect(portalCheckUrl("https://portal.example.org", null).href).toBe("https://portal.example.org/api/auth/parent/portal-passkey/check");
    expect(portalCheckUrl("https://portal.example.org", "/forms/1?x=2").href)
      .toBe("https://portal.example.org/api/auth/parent/portal-passkey/check?next=%2Fforms%2F1%3Fx%3D2");
  });

  it("better-fetch's onRequest hook changes the request's address and nothing else", () => {
    const sent = { url: "http://localhost:3000/api/auth/parent/passkey/verify-authentication", method: "POST", body: JSON.stringify({ response: { id: "x" } }) };
    const changed = toPortalCheck("http://localhost:3000", "/payments").onRequest(sent);
    expect({ ...changed, url: undefined }).toEqual({ ...sent, url: undefined });
    const url = new URL(String(changed.url));
    expect(url.pathname).toBe(PASSKEY_CHECK_PATH);
    expect(url.pathname).not.toContain("/passkey/verify-authentication");
    expect(url.searchParams.get("next")).toBe("/payments");
  });
});

describe("whether the browser can use a passkey", () => {
  it("needs WebAuthn's credential interface and navigator.credentials.get()", () => {
    class PublicKeyCredential {}
    expect(passkeysWorkIn({ PublicKeyCredential, navigator: { credentials: { get: () => null } } })).toBe(true);
    expect(passkeysWorkIn({ navigator: { credentials: { get: () => null } } })).toBe(false);
    expect(passkeysWorkIn({ PublicKeyCredential, navigator: {} })).toBe(false);
    expect(passkeysWorkIn({})).toBe(false);
  });
});

describe("what the ceremony came to", () => {
  it("a cancel or the browser's refusal is a cancel, never a throw", () => {
    expect(readCeremony({ data: null, error: { code: "AUTH_CANCELLED", status: 400 } })).toEqual({ kind: "cancelled" });
    expect(readCeremony({ data: null, error: { code: "ERROR_CEREMONY_ABORTED", status: 400 } })).toEqual({ kind: "cancelled" });
  });
  it("the portal's answer is the answer, whatever it says", () => {
    expect(readCeremony({ data: { ok: true, next: "/" }, error: null })).toEqual({ kind: "answer", body: { ok: true, next: "/" } });
    expect(readCeremony({ data: { ok: false, error: "rejected", ended: true }, error: null })).toEqual({ kind: "answer", body: { ok: false, error: "rejected", ended: true } });
  });
  it("anything else failed, with its status when there is one", () => {
    expect(readCeremony({ data: null, error: { status: 429 } })).toEqual({ kind: "failed", status: 429 });
    expect(readCeremony({ data: null, error: { code: "TOO_MANY", status: "x" } })).toEqual({ kind: "failed", status: null });
    expect(readCeremony({ data: "<html>", error: null })).toEqual({ kind: "failed", status: null });
    expect(readCeremony(null)).toEqual({ kind: "failed", status: null });
  });
});
