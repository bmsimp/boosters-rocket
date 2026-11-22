import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetDiscovery, isIntuitEndpoint, oauthEndpoints } from "@/lib/quickbooks/discovery";
import { qboEndpoints } from "@/lib/quickbooks/endpoints";

// The OAuth endpoints come from Intuit's discovery document, kept 24 hours; a failed read or an endpoint off intuit.com
// falls back to the constants in endpoints.ts, and says so in the log.
const FALLBACK = { authorize: qboEndpoints().authorize, token: qboEndpoints().token, revoke: qboEndpoints().revoke };
const FROM_DOC = {
  authorize: "https://appcenter.intuit.com/connect/oauth2/v2",
  token: "https://oauth.platform.intuit.com/oauth2/v2/tokens/bearer",
  revoke: "https://developer.api.intuit.com/v3/oauth2/tokens/revoke",
};
const doc = (e = FROM_DOC) => ({ issuer: "https://oauth.platform.intuit.com/op/v1", authorization_endpoint: e.authorize, token_endpoint: e.token, revocation_endpoint: e.revoke });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  forgetDiscovery();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); warn.mockRestore(); });

describe("Intuit's discovery document", () => {
  it("names the endpoints, read from the environment's own document", async () => {
    fetchMock.mockImplementation(async () => answer(doc()));
    expect(await oauthEndpoints("production")).toEqual(FROM_DOC);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://developer.api.intuit.com/.well-known/openid_configuration");
    forgetDiscovery();
    await oauthEndpoints("sandbox");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://developer.api.intuit.com/.well-known/openid_sandbox_configuration");
    expect(warn).not.toHaveBeenCalled();
  });

  it("is kept for 24 hours, then read again", async () => {
    fetchMock.mockImplementation(async () => answer(doc()));
    const t0 = Date.now();
    await oauthEndpoints("production", t0);
    expect(await oauthEndpoints("production", t0 + 23 * 3_600_000)).toEqual(FROM_DOC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await oauthEndpoints("production", t0 + 24 * 3_600_000 + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["another host", { ...FROM_DOC, token: "https://attacker.example/tokens" }],
    ["a look-alike host", { ...FROM_DOC, token: "https://oauth.intuit.com.attacker.example/tokens" }],
    ["plain http", { ...FROM_DOC, revoke: "http://developer.api.intuit.com/v2/oauth2/tokens/revoke" }],
    ["a user in the address", { ...FROM_DOC, authorize: "https://user:pw@appcenter.intuit.com/connect/oauth2" }],
  ])("refuses %s and uses the fallback", async (_why, endpoints) => {
    fetchMock.mockResolvedValue(answer(doc(endpoints)));
    expect(await oauthEndpoints("production")).toEqual(FALLBACK);
    expect(String(warn.mock.calls[0]![0])).toContain('"reason":"not_intuit"');
  });

  it.each([
    ["unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    ["http_503", () => Promise.resolve(new Response("down", { status: 503 }))],
    ["not_json", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["missing_endpoint", () => Promise.resolve(answer({ issuer: "x" }))],
  ])("falls back when the read fails (%s), logs it, and asks again in 5 minutes", async (reason, reply) => {
    fetchMock.mockImplementation(reply);
    const t0 = Date.now();
    expect(await oauthEndpoints("production", t0)).toEqual(FALLBACK);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ event: "quickbooks.discovery_fallback", environment: "production", reason });
    await oauthEndpoints("production", t0 + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(answer(doc()));
    expect(await oauthEndpoints("production", t0 + 5 * 60_000 + 1)).toEqual(FROM_DOC);
  });

  it("checks every endpoint's host", () => {
    expect(isIntuitEndpoint("https://intuit.com/x")).toBe(true);
    expect(isIntuitEndpoint("https://oauth.platform.intuit.com/x")).toBe(true);
    expect(isIntuitEndpoint("https://notintuit.com/x")).toBe(false);
    expect(isIntuitEndpoint("javascript:alert(1)")).toBe(false);
    expect(isIntuitEndpoint(42)).toBe(false);
  });
});
