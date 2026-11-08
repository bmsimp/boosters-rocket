import { describe, it, expect } from "vitest";
import { clientIpFrom } from "@/lib/request";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIpFrom", () => {
  it("prefers Cloudflare's connecting-ip header over everything else", () => {
    expect(clientIpFrom(h({ "cf-connecting-ip": "203.0.113.7", "x-real-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1, 198.51.100.2" })))
      .toBe("203.0.113.7");
  });

  it("never uses the client-controlled first X-Forwarded-For entry", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip before X-Forwarded-For", () => {
    expect(clientIpFrom(h({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.9" }))).toBe("198.51.100.1");
  });

  it("treats empty and malformed values as absent", () => {
    expect(clientIpFrom(h({ "cf-connecting-ip": "", "x-real-ip": "  ", "x-forwarded-for": "203.0.113.9, " }))).toBe("203.0.113.9");
    expect(clientIpFrom(h({ "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "1.2.3.4, nonsense" }))).toBeNull();
    expect(clientIpFrom(h({}))).toBeNull();
  });

  it("accepts IPv6", () => {
    expect(clientIpFrom(h({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });
});
