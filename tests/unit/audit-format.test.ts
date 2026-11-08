import { describe, it, expect } from "vitest";
import { formatAuditDetails } from "@/lib/audit/format";

describe("formatAuditDetails", () => {
  it("returns null when both are empty", () => {
    expect(formatAuditDetails(null, null)).toBeNull();
    expect(formatAuditDetails(undefined, undefined)).toBeNull();
  });
  it("shows a refusal reason from after", () => {
    expect(formatAuditDetails(null, { reason: "no_guardian" })).toBe('{"reason":"no_guardian"}');
  });
  it("shows before → after", () => {
    expect(formatAuditDetails({ a: 1 }, { a: 2 })).toBe('{"a":1} → {"a":2}');
  });
  it("keeps falsy values that are present", () => {
    expect(formatAuditDetails(null, 0)).toBe("0");
  });
});
