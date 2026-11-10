import { describe, it, expect, vi, beforeAll } from "vitest";
import { checkMicrosoft, checkFor } from "@/lib/auth/provider-checks";
import { generateCertificate } from "@/lib/auth/certificate-crypto";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const aad = (code: number) => json(400, { error: "invalid_client", error_codes: [code] });

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
});
