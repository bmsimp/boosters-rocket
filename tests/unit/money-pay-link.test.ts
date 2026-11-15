import { describe, it, expect } from "vitest";
import { safePayLink } from "@/lib/money/pay-link";

describe("a Pay button opens only QuickBooks' own payment page (v1 spec §8.2)", () => {
  it.each([
    ["https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-abc123", "https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-abc123"],
    ["https://intuit.com/pay/1", "https://intuit.com/pay/1"],
    ["https://developer.intuit.com/comingSoonview/scmb/US/sandbox/scs-v1-1?locale=en_US&cta=pay", "https://developer.intuit.com/comingSoonview/scmb/US/sandbox/scs-v1-1?locale=en_US&cta=pay"],
    ["  https://connect.intuit.com/t/abc  ", "https://connect.intuit.com/t/abc"],
    ["HTTPS://CONNECT.INTUIT.COM/t/abc", "https://connect.intuit.com/t/abc"],
    ["https://connect.intuit.com./t/abc", "https://connect.intuit.com./t/abc"],
    ["https://a.b.c.intuit.com:8443/x#y", "https://a.b.c.intuit.com:8443/x#y"],
  ])("accepts %s", (raw, link) => { expect(safePayLink(raw)).toBe(link); });

  it.each([
    ["plain http", "http://connect.intuit.com/t/abc"],
    ["a javascript: address", "javascript:alert(1)"],
    ["a javascript: address dressed as Intuit", "javascript://connect.intuit.com/%0aalert(1)"],
    ["a data: address", "data:text/html,<script>alert(1)</script>"],
    ["a data: address naming Intuit", "data:text/html;base64,aHR0cHM6Ly9pbnR1aXQuY29t"],
    ["another scheme", "ftp://connect.intuit.com/t/abc"],
    ["a user name", "https://someone@connect.intuit.com/t/abc"],
    ["a user name and password", "https://someone:secret@connect.intuit.com/t/abc"],
    ["Intuit as the user name of another host", "https://connect.intuit.com@evil.example/t/abc"],
    ["another host", "https://evil.example/intuit.com"],
    ["a host that only ends with the letters", "https://notintuit.com/t/abc"],
    ["a host that only starts with Intuit", "https://intuit.com.evil.example/t/abc"],
    ["Intuit in the path", "https://evil.example/connect.intuit.com/t/abc"],
    ["Intuit in the query", "https://evil.example/?next=https://connect.intuit.com"],
    ["a backslash trick", "https://evil.example\\@connect.intuit.com/t/abc"],
    ["a relative address", "/pay/1"],
    ["an address with no scheme", "connect.intuit.com/t/abc"],
    ["a scheme-relative address", "//connect.intuit.com/t/abc"],
    ["text that isn't an address", "Pay here"],
    ["nothing", ""],
    ["only spaces", "   "],
  ])("refuses %s", (_what, raw) => { expect(safePayLink(raw)).toBeNull(); });

  it("refuses anything that isn't text, and an address too long to be one", () => {
    for (const raw of [undefined, null, 42, true, {}, ["https://connect.intuit.com/t/abc"], { href: "https://connect.intuit.com/t/abc" }]) expect(safePayLink(raw)).toBeNull();
    expect(safePayLink(`https://connect.intuit.com/${"a".repeat(2000)}`)).toBeNull();
  });

  it("gives back the address as the URL parser read it, not the raw text", () => {
    expect(safePayLink("https://connect.intuit.com/a b\"c<d>")).toBe("https://connect.intuit.com/a%20b%22c%3Cd%3E");
    expect(safePayLink("https://connect.intuit.com/\tt/a\nbc")).toBe("https://connect.intuit.com/t/abc");
  });
});
