import { describe, it, expect } from "vitest";
import { expiringSecrets } from "@/app/staff/(app)/secret-expiry-rule";

const now = new Date("2026-11-08T00:00:00Z");
const s = (key: "staff-microsoft" | "parent-oidc", expires: string | null, readable = true) =>
  ({ key, config: {}, credentialUpdatedAt: now, expiresAt: expires ? new Date(expires) : null, readable, certificate: null, pendingCertificate: null });

describe("expiringSecrets", () => {
  it("warns from 30 days before expiry, and after", () => {
    expect(expiringSecrets([s("staff-microsoft", "2026-12-09T00:00:00Z")], now)).toHaveLength(0);
    expect(expiringSecrets([s("staff-microsoft", "2026-12-07T00:00:00Z")], now)).toHaveLength(1);
    expect(expiringSecrets([s("staff-microsoft", "2026-11-01T00:00:00Z")], now)).toHaveLength(1);
  });
  it("ignores secrets with no expiry date, and always warns about unreadable ones", () => {
    expect(expiringSecrets([s("parent-oidc", null)], now)).toHaveLength(0);
    expect(expiringSecrets([s("parent-oidc", null, false)], now)).toEqual([{ key: "parent-oidc", expiresAt: null, unreadable: true }]);
  });
});
