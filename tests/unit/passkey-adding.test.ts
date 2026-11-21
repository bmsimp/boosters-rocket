import { describe, it, expect } from "vitest";
import { PASSKEY_ADD_PATH, PASSKEY_AGAIN_PATH, addBody, passkeysAddIn, toPortalAdd, toPortalAgain } from "@/app/(parent)/family/sign-in/passkey-adding";

/**
 * The browser side of adding a passkey and asking again with one (the sign-in release, slice SI-7b): the library's
 * verify requests are sent to the portal's own endpoints, and the typed name goes only in the add's body, never in the
 * library's options (whose `name` query would become the passkey's user name in a password manager).
 */
describe("the add's and asking again's verify requests", () => {
  const origin = "https://portal.example.org";

  it("send the add to the portal's own path, keeping the library's answer and putting the trimmed name beside it", () => {
    const hook = toPortalAdd(origin, "  Sam's iPhone ");
    const out = hook.onRequest({ url: "https://portal.example.org/api/auth/parent/passkey/verify-registration", body: JSON.stringify({ response: { id: "abc" }, name: undefined }), method: "POST" });
    expect(String(out.url)).toBe(`${origin}${PASSKEY_ADD_PATH}`);
    expect(JSON.parse(out.body as string)).toEqual({ response: { id: "abc" }, name: "Sam's iPhone" });
    expect(out.method).toBe("POST");
  });

  it("send no name when none was typed, and a null answer for a body that isn't the library's", () => {
    expect(JSON.parse(addBody(JSON.stringify({ response: { id: "abc" } }), "   "))).toEqual({ response: { id: "abc" } });
    expect(JSON.parse(addBody("not json", ""))).toEqual({ response: null });
    expect(JSON.parse(addBody(undefined, "x"))).toEqual({ response: null, name: "x" });
  });

  it("send asking again to the portal's own path, with the body as the library built it", () => {
    const out = toPortalAgain(origin).onRequest({ url: "https://elsewhere.example/api/auth/parent/passkey/verify-authentication", body: "{\"response\":{}}" });
    expect(String(out.url)).toBe(`${origin}${PASSKEY_AGAIN_PATH}`);
    expect(out.body).toBe("{\"response\":{}}");
  });

  it("tell whether a browser can make a passkey", () => {
    expect(passkeysAddIn({})).toBe(false);
    expect(passkeysAddIn({ PublicKeyCredential: function () {}, navigator: { credentials: {} } })).toBe(false);
    expect(passkeysAddIn({ PublicKeyCredential: function () {}, navigator: { credentials: { create: () => null } } })).toBe(true);
  });
});
