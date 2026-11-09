import { describe, it, expect, vi } from "vitest";
import { checkMicrosoft, checkParent, checkFor } from "@/lib/auth/provider-checks";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const aad = (code: number) => json(400, { error: "invalid_client", error_codes: [code] });

describe("checkMicrosoft", () => {
  it("passes when the token request succeeds, and sends the right request", async () => {
    const f = vi.fn(async () => json(200, { access_token: "t" }));
    expect(await checkMicrosoft({ tenantId: T, clientId: C }, "s3cret", f)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`);
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "client_credentials", client_id: C, client_secret: "s3cret", scope: "https://graph.microsoft.com/.default" });
  });

  it.each([
    [7000215, /rejected the client secret.*15 minutes/],
    [7000222, /expired/],
    [700016, /doesn't know that Application \(client\) ID/],
    [90002, /can't find that tenant/],
  ])("explains AADSTS%s", async (code, msg) => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, "s", async () => aad(code));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(msg);
  });

  it("names an unknown code", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, "s", async () => aad(1234));
    expect(!r.ok && r.message).toMatch(/AADSTS1234/);
  });

  it("doesn't blame the values when Microsoft can't be reached", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, "s", async () => { throw new TypeError("fetch failed"); });
    expect(!r.ok && r.message).toMatch(/Couldn't reach Microsoft/);
  });
});

describe("checkParent", () => {
  const c = { tenantSubdomain: "fznparents", tenantId: T, clientId: C };
  const discovery = `https://fznparents.ciamlogin.com/${T}/v2.0/.well-known/openid-configuration`;
  const doc = { issuer: `https://${T}.ciamlogin.com/${T}/v2.0`, token_endpoint: `https://fznparents.ciamlogin.com/${T}/oauth2/v2.0/token` };

  it("loads discovery, checks the issuer, then requests a token", async () => {
    const f = vi.fn(async (url: string) => (url === discovery ? json(200, doc) : json(200, { access_token: "t" })));
    expect(await checkParent(c, "s", f)).toEqual({ ok: true });
    expect(f.mock.calls.map((x) => x[0])).toEqual([discovery, doc.token_endpoint]);
  });

  it("refuses a discovery document from another tenant", async () => {
    const r = await checkParent(c, "s", async () => json(200, { ...doc, issuer: "https://other.ciamlogin.com/x/v2.0" }));
    expect(!r.ok && r.message).toMatch(/different tenant/);
  });

  it("explains a subdomain/tenant pair that doesn't exist", async () => {
    const r = await checkParent(c, "s", async () => json(400, { error: "invalid_tenant" }));
    expect(!r.ok && r.message).toMatch(/no External ID tenant/);
  });

  it("passes the token error through", async () => {
    const f = async (url: string) => (url === discovery ? json(200, doc) : aad(7000215));
    const r = await checkParent(c, "s", f);
    expect(!r.ok && r.message).toMatch(/rejected the client secret/);
  });
});

describe("checkFor", () => {
  it("does no network check for Google", async () => {
    const f = vi.fn();
    expect(await checkFor({ key: "staff-google", config: { clientId: "x.apps.googleusercontent.com" }, secret: "s", secretExpiresAt: null }, f)).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
  });
});
