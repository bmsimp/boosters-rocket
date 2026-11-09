import { describe, it, expect } from "vitest";
import { parseProviderForm, cleanSecret, parentDiscoveryUrl } from "@/lib/auth/providers";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";

describe("parseProviderForm", () => {
  it("accepts a Microsoft staff provider and lower-cases the IDs", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: ` ${T.toUpperCase()} `, clientId: C, secret: "abc", secretExpiresAt: "2028-11-08" });
    expect(r).toEqual({ ok: true, draft: { key: "staff-microsoft", config: { tenantId: T, clientId: C }, secret: "abc", secretExpiresAt: new Date("2028-11-08T00:00:00Z") } });
  });

  it.each(["common", "organizations", "consumers"])("refuses the multi-tenant alias %s", (v) => {
    const r = parseProviderForm("staff-microsoft", { tenantId: v, clientId: C, secret: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/any Microsoft account/);
  });

  it("explains a domain pasted as tenant ID", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: "club.onmicrosoft.com", clientId: C, secret: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Directory \(tenant\) ID.*domain name/);
  });

  it("cleans pasted secrets", () => {
    expect(cleanSecret('  "abc~def"\n')).toBe("abc~def");
    expect(cleanSecret("'abc'")).toBe("abc");
    expect(cleanSecret(" abc ")).toBe("abc");
    const r = parseProviderForm("staff-google", { clientId: "123-x.apps.googleusercontent.com", secret: " s \n" });
    expect(r.ok && r.draft.secret).toBe("s");
  });

  it("treats a blank secret as keep-the-saved-one", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: "   " });
    expect(r.ok && r.draft.secret).toBeNull();
  });

  it("refuses a Google client ID that isn't one", () => {
    const r = parseProviderForm("staff-google", { clientId: "12345", secret: "s" });
    expect(r.ok).toBe(false);
  });

  it("accepts a parent provider and trims a pasted domain down to the subdomain", () => {
    const r = parseProviderForm("parent-oidc", { tenantSubdomain: "FznParents.onmicrosoft.com", tenantId: T, clientId: C, secret: "s" });
    expect(r.ok && r.draft.config).toEqual({ tenantSubdomain: "fznparents", tenantId: T, clientId: C });
  });

  it("refuses a bad expiry date", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: "s", secretExpiresAt: "next year" });
    expect(r.ok).toBe(false);
  });

  it("builds the documented discovery URL", () => {
    expect(parentDiscoveryUrl({ tenantSubdomain: "fznparents", tenantId: T, clientId: C }))
      .toBe(`https://fznparents.ciamlogin.com/${T}/v2.0/.well-known/openid-configuration`);
  });
});
