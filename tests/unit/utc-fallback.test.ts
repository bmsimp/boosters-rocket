import { describe, it, expect } from "vitest";
import { utcFallback } from "@/app/components/utc-fallback";

describe("utcFallback", () => {
  it("formats an ISO instant as UTC text", () => {
    expect(utcFallback("2026-11-08T17:27:13.456Z")).toBe("2026-11-08 17:27 UTC");
  });
});
