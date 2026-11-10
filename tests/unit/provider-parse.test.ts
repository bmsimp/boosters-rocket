import { describe, it, expect } from "vitest";
import { parseProviderForm, cleanSecret } from "@/lib/auth/providers";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const G = "123-x.apps.googleusercontent.com";

describe("parseProviderForm", () => {
  it("accepts a Microsoft staff provider and lower-cases the IDs", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: ` ${T.toUpperCase()} `, clientId: C });
    expect(r).toEqual({ ok: true, draft: { key: "staff-microsoft", config: { tenantId: T, clientId: C } } });
  });

  it("gives a Microsoft draft no secret, even when one is sent", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: "ignored" });
    expect(r.ok).toBe(true);
    if (r.ok) expect("secret" in r.draft).toBe(false);
  });

  it("ignores an expiry sent for Microsoft", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secretExpiresAt: "next year" });
    expect(r).toEqual({ ok: true, draft: { key: "staff-microsoft", config: { tenantId: T, clientId: C } } });
  });

  it.each(["common", "organizations", "consumers"])("refuses the multi-tenant alias %s", (v) => {
    const r = parseProviderForm("staff-microsoft", { tenantId: v, clientId: C });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/any Microsoft account/);
  });

  it("explains a domain pasted as tenant ID", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: "club.onmicrosoft.com", clientId: C });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Directory \(tenant\) ID.*domain name/);
  });

  it("cleans pasted Google secrets", () => {
    expect(cleanSecret('  "abc~def"\n')).toBe("abc~def");
    expect(cleanSecret("'abc'")).toBe("abc");
    expect(cleanSecret(" abc ")).toBe("abc");
    const r = parseProviderForm("staff-google", { clientId: G, secret: " s \n" });
    expect(r.ok && r.draft.key === "staff-google" && r.draft.secret).toBe("s");
  });

  it("treats a blank Google secret as keep-the-saved-one", () => {
    const r = parseProviderForm("staff-google", { clientId: G, secret: "   " });
    expect(r).toEqual({ ok: true, draft: { key: "staff-google", config: { clientId: G }, secret: null, secretExpiresAt: null } });
  });

  it("refuses a Google client ID that isn't one", () => {
    const r = parseProviderForm("staff-google", { clientId: "12345", secret: "s" });
    expect(r.ok).toBe(false);
  });

  it("refuses a bad Google expiry date", () => {
    const r = parseProviderForm("staff-google", { clientId: G, secret: "s", secretExpiresAt: "next year" });
    expect(r.ok).toBe(false);
  });
});
