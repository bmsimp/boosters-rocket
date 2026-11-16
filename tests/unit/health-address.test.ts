import { describe, it, expect } from "vitest";
import { originOf, sameAddress } from "@/lib/health/address";

describe("the portal's address against the one the browser used", () => {
  it("reads an address as scheme, host and port", () => {
    expect(originOf("https://portal.yourclub.org")).toBe("https://portal.yourclub.org");
    expect(originOf("https://portal.yourclub.org/")).toBe("https://portal.yourclub.org");
    expect(originOf("HTTPS://Portal.YourClub.org:443/x?y")).toBe("https://portal.yourclub.org");
    expect(originOf("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["", "portal.yourclub.org", "javascript:alert(1)", "ftp://portal.yourclub.org", "null"]) expect(originOf(bad), bad).toBeNull();
  });

  it("matches only the same scheme, host and port", () => {
    expect(sameAddress("https://portal.yourclub.org/", "https://portal.yourclub.org")).toBe(true);
    expect(sameAddress("https://portal.yourclub.org", "https://PORTAL.yourclub.org:443")).toBe(true);
    expect(sameAddress("https://portal.yourclub.org", "http://portal.yourclub.org")).toBe(false);
    expect(sameAddress("https://portal.yourclub.org", "https://www.yourclub.org")).toBe(false);
    expect(sameAddress("http://localhost:3000", "http://127.0.0.1:3000")).toBe(false);
    expect(sameAddress("http://localhost:3000", "http://localhost:3100")).toBe(false);
    // An address that can't be read never counts as a match.
    expect(sameAddress("not an address", "not an address")).toBe(false);
    expect(sameAddress("https://portal.yourclub.org", "null")).toBe(false);
  });
});
