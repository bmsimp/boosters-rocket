import { describe, it, expect, vi, beforeAll } from "vitest";
import { checkMicrosoft, checkParent, checkFor } from "@/lib/auth/provider-checks";
import { generateCertificate } from "@/lib/auth/certificate-crypto";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const aad = (code: number) => json(400, { error: "invalid_client", error_codes: [code] });
const payloadOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

let key: { privateKeyPem: string; thumbprintS256: string; thumbprintSha1Base64Url: string };
beforeAll(async () => {
  const g = await generateCertificate("t");
  key = { privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, thumbprintSha1Base64Url: Buffer.from(g.thumbprintSha1, "hex").toString("base64url") };
});

describe("checkMicrosoft", () => {
  it("sends the token request to the tenant's endpoint", async () => {
    const f = vi.fn(async () => json(200, { access_token: "t" }));
    expect(await checkMicrosoft({ tenantId: T, clientId: C }, key, f)).toEqual({ ok: true });
    const [url] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`);
  });

  it("sends a client assertion and never a client secret", async () => {
    const f = vi.fn(async () => json(200, { access_token: "t" }));
    expect(await checkMicrosoft({ tenantId: T, clientId: C }, key, f)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = Object.fromEntries(new URLSearchParams(String(init.body)));
    expect(body).toMatchObject({ grant_type: "client_credentials", client_id: C, scope: "https://graph.microsoft.com/.default",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" });
    expect(body.client_secret).toBeUndefined();
    expect(JSON.parse(Buffer.from(body.client_assertion!.split(".")[1]!, "base64url").toString()).aud).toBe(url);
  });

  it.each([
    [700027, /doesn't have this certificate on the app yet/],
    [700024, /server's clock looks wrong/],
    [700016, /doesn't know that Application \(client\) ID/],
    [90002, /can't find that tenant/],
  ])("explains AADSTS%s", async (code, msg) => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, key, async () => aad(code));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(msg);
  });

  it("names an unknown code", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, key, async () => aad(1234));
    expect(!r.ok && r.message).toMatch(/AADSTS1234/);
  });

  it("names the old secret codes as unknown now that there is no secret", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, key, async () => aad(7000215));
    expect(!r.ok && r.message).toMatch(/AADSTS7000215/);
  });

  it("doesn't blame the values when Microsoft can't be reached", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, key, async () => { throw new TypeError("fetch failed"); });
    expect(!r.ok && r.message).toMatch(/Couldn't reach Microsoft/);
  });

  it("treats a 5xx as unreachable", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, key, async () => json(503, {}));
    expect(!r.ok && r.message).toMatch(/Couldn't reach Microsoft/);
  });
});

describe("checkParent", () => {
  const c = { tenantSubdomain: "fznparents", tenantId: T, clientId: C };
  const discovery = `https://fznparents.ciamlogin.com/${T}/v2.0/.well-known/openid-configuration`;
  const doc = { issuer: `https://${T}.ciamlogin.com/${T}/v2.0`, token_endpoint: `https://fznparents.ciamlogin.com/${T}/oauth2/v2.0/token` };

  it("loads discovery, checks the issuer, then requests a token", async () => {
    const f = vi.fn(async (url: string) => (url === discovery ? json(200, doc) : json(200, { access_token: "t" })));
    expect(await checkParent(c, key, f)).toEqual({ ok: true });
    expect(f.mock.calls.map((x) => x[0])).toEqual([discovery, doc.token_endpoint]);
  });

  it("signs the parent assertion for the discovered token endpoint", async () => {
    const f = vi.fn(async (url: string) => (url === discovery ? json(200, doc) : json(200, { access_token: "t" })));
    await checkParent(c, key, f);
    const init = (f.mock.calls[1] as unknown as [string, RequestInit])[1];
    const params = new URLSearchParams(String(init.body));
    expect(params.get("client_secret")).toBeNull();
    const assertion = params.get("client_assertion")!;
    expect(payloadOf(assertion).aud).toBe(doc.token_endpoint);
  });

  it("refuses a discovery document from another tenant", async () => {
    const r = await checkParent(c, key, async () => json(200, { ...doc, issuer: "https://other.ciamlogin.com/x/v2.0" }));
    expect(!r.ok && r.message).toMatch(/different tenant/);
  });

  it("explains a subdomain/tenant pair that doesn't exist", async () => {
    const r = await checkParent(c, key, async () => json(400, { error: "invalid_tenant" }));
    expect(!r.ok && r.message).toMatch(/no External ID tenant/);
  });

  it("refuses a discovery body that is null or not an object", async () => {
    const r = await checkParent(c, key, async () => json(200, null));
    expect(!r.ok && r.message).toMatch(/look incomplete/);
  });

  it.each([
    ["an http:// endpoint", `http://fznparents.ciamlogin.com/${T}/oauth2/v2.0/token`],
    ["an endpoint on another host", "https://evil.example.com/token"],
  ])("never sends an assertion to %s", async (_label, endpoint) => {
    const f = vi.fn(async (url: string) => (url === discovery ? json(200, { ...doc, token_endpoint: endpoint }) : json(200, { access_token: "t" })));
    const r = await checkParent(c, key, f);
    expect(!r.ok && r.message).toMatch(/point somewhere unexpected, so nothing was sent/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe(discovery);
  });

  it("passes the token error through", async () => {
    const f = async (url: string) => (url === discovery ? json(200, doc) : aad(700027));
    const r = await checkParent(c, key, f);
    expect(!r.ok && r.message).toMatch(/doesn't have this certificate on the app yet/);
  });
});

describe("checkFor", () => {
  it("does no network check for Google", async () => {
    const f = vi.fn();
    expect(await checkFor({ key: "staff-google", config: { clientId: "x.apps.googleusercontent.com" }, secret: "s" }, f)).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
  });

  it("checks Microsoft with the draft's assertion", async () => {
    const f = vi.fn(async () => json(200, { access_token: "t" }));
    expect(await checkFor({ key: "staff-microsoft", config: { tenantId: T, clientId: C }, assertion: key }, f)).toEqual({ ok: true });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new URLSearchParams(String(init.body)).get("client_assertion")).toBeTruthy();
  });
});

describe("redirects never carry the assertion", () => {
  const redirectingFetch = () => vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
    return json(200, {});
  });

  it("asks fetch to fail on a redirect for the token request, and reports it as unreachable", async () => {
    const f = redirectingFetch();
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, key, f);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
    expect(!r.ok && r.message).toMatch(/Couldn't reach Microsoft/);
  });

  it("does the same for the parent discovery request, so nothing is sent", async () => {
    const f = redirectingFetch();
    const r = await checkParent({ tenantSubdomain: "club", tenantId: T, clientId: C }, key, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
    expect(!r.ok && r.message).toMatch(/Couldn't reach Microsoft/);
  });

  it("asks fetch to fail on a redirect for the parent token request too", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => url.includes("openid-configuration")
      ? json(200, { issuer: `https://club.ciamlogin.com/${T}/v2.0`, token_endpoint: `https://club.ciamlogin.com/${T}/oauth2/v2.0/token` })
      : json(200, init?.redirect === "error" ? {} : { leaked: true }));
    expect(await checkParent({ tenantSubdomain: "club", tenantId: T, clientId: C }, key, f)).toEqual({ ok: true });
    expect(f.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1].redirect)).toEqual(["error", "error"]);
  });
});
