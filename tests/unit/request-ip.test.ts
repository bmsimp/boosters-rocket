import { describe, it, expect } from "vitest";
import { CLIENT_IP_STAMP, clientIpFrom, stampClientIp, withClientIp } from "@/lib/request";
import { env, DEFAULT_CLIENT_IP_HEADER } from "@/env";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIpFrom", () => {
  it("reads Cloudflare's header when the setting is left alone, as before there was a setting", () => {
    expect(DEFAULT_CLIENT_IP_HEADER).toBe("cf-connecting-ip");
    expect(env.CLIENT_IP_HEADER).toBe("cf-connecting-ip");
    expect(clientIpFrom(h({ "cf-connecting-ip": "203.0.113.7", "x-real-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1, 198.51.100.2" })))
      .toBe("203.0.113.7");
  });

  it("believes the one header the deployment names, and no other", () => {
    const sent = h({ "cf-connecting-ip": "203.0.113.7", "x-real-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1, 198.51.100.2", "fly-client-ip": "192.0.2.44" });
    expect(clientIpFrom(sent, "x-real-ip")).toBe("198.51.100.1");
    expect(clientIpFrom(sent, "x-forwarded-for")).toBe("198.51.100.2");
    expect(clientIpFrom(sent, "fly-client-ip")).toBe("192.0.2.44");
    expect(clientIpFrom(sent, "x-client-ip")).toBeNull();
  });

  it("gives nothing when the named header is absent, whatever else the client sent", () => {
    // Behind Cloudflare a request without its header did not come through Cloudflare: nothing it says is believed.
    expect(clientIpFrom(h({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.9", forwarded: "for=203.0.113.9" }))).toBeNull();
    expect(clientIpFrom(h({ "cf-connecting-ip": "203.0.113.7" }), "x-forwarded-for")).toBeNull();
    expect(clientIpFrom(h({}))).toBeNull();
  });

  it("gives nothing at all when the setting is none", () => {
    expect(clientIpFrom(h({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.9", none: "203.0.113.10" }), "none")).toBeNull();
  });

  it("reads a list from the right: the last entry is the proxy's, the ones before it may be the client's", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), "x-forwarded-for")).toBe("203.0.113.9");
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4,5.6.7.8 ,  203.0.113.9  " }), "x-forwarded-for")).toBe("203.0.113.9");
    expect(clientIpFrom(h({ "x-forwarded-for": "203.0.113.9" }), "x-forwarded-for")).toBe("203.0.113.9");
    // The same header sent twice arrives joined into one list: a client that sends its own ahead of the proxy's gains nothing.
    const twice = new Headers(); twice.append("cf-connecting-ip", "1.2.3.4"); twice.append("cf-connecting-ip", "203.0.113.7");
    expect(clientIpFrom(twice)).toBe("203.0.113.7");
  });

  it("never steps left past a last entry it can't read", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, nonsense" }), "x-forwarded-for")).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, unknown" }), "x-forwarded-for")).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9:port" }), "x-forwarded-for")).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, 999.1.1.1" }), "x-forwarded-for")).toBeNull();
  });

  it("treats empty and malformed values as absent", () => {
    expect(clientIpFrom(h({ "cf-connecting-ip": "" }))).toBeNull();
    expect(clientIpFrom(h({ "cf-connecting-ip": "  " }))).toBeNull();
    expect(clientIpFrom(h({ "cf-connecting-ip": "not-an-ip" }))).toBeNull();
    expect(clientIpFrom(h({ "cf-connecting-ip": "203.0.113.9; drop table" }))).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": "203.0.113.9, " }), "x-forwarded-for")).toBe("203.0.113.9");
  });

  it("accepts IPv6, and drops a port some hosts add", () => {
    expect(clientIpFrom(h({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIpFrom(h({ "cf-connecting-ip": "2001:DB8::A" }))).toBe("2001:db8::a");
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.7:51234" }), "x-forwarded-for")).toBe("203.0.113.7");
    expect(clientIpFrom(h({ "x-forwarded-for": "[2001:db8::1]:51234" }), "x-forwarded-for")).toBe("2001:db8::1");
    expect(clientIpFrom(h({ "x-forwarded-for": "[2001:db8::1]" }), "x-forwarded-for")).toBe("2001:db8::1");
    expect(clientIpFrom(h({ "x-forwarded-for": "[203.0.113.7]:80" }), "x-forwarded-for")).toBeNull();
  });
});

describe("the address handed to Better Auth", () => {
  it("is what clientIpFrom() found, under the portal's own header", () => {
    const out = stampClientIp(h({ "cf-connecting-ip": "203.0.113.7", cookie: "a=b" }));
    expect(out.get(CLIENT_IP_STAMP)).toBe("203.0.113.7");
    expect(out.get("cookie")).toBe("a=b");
  });

  it("replaces one a client sent, and removes it when the address is unknown", () => {
    expect(stampClientIp(h({ [CLIENT_IP_STAMP]: "6.6.6.6", "cf-connecting-ip": "203.0.113.7" })).get(CLIENT_IP_STAMP)).toBe("203.0.113.7");
    expect(stampClientIp(h({ [CLIENT_IP_STAMP]: "6.6.6.6" })).has(CLIENT_IP_STAMP)).toBe(false);
    expect(stampClientIp(h({ [CLIENT_IP_STAMP]: "6.6.6.6", "x-forwarded-for": "6.6.6.6", "x-real-ip": "6.6.6.6" })).has(CLIENT_IP_STAMP)).toBe(false);
  });

  it("leaves the request as it was in every other way: its address, method, body and other headers", async () => {
    const req = new Request("https://portal.example.org/api/auth/parent/portal-code/send?x=1", {
      method: "POST", body: JSON.stringify({ email: "ana@example.com" }),
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", [CLIENT_IP_STAMP]: "6.6.6.6" },
    });
    const out = withClientIp(req);
    expect(out.url).toBe("https://portal.example.org/api/auth/parent/portal-code/send?x=1");
    expect(out.method).toBe("POST");
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(out.headers.get(CLIENT_IP_STAMP)).toBe("203.0.113.7");
    expect(await out.json()).toEqual({ email: "ana@example.com" });
  });
});
