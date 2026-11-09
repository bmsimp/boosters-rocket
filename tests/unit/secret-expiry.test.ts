import { describe, it, expect } from "vitest";
import { expiringSecrets, certificateNextStep } from "@/app/staff/(app)/secret-expiry-rule";

const now = new Date("2026-11-08T00:00:00Z");
const view = { id: "x", thumbprintSha1: "AB", thumbprintS256: "cd", notAfter: now, createdAt: now };
const s = (key: "staff-microsoft" | "parent-oidc", expires: string | null, readable = true, pending: "none" | "readable" | "unreadable" = "none") =>
  ({ key, config: {}, credentialUpdatedAt: now, expiresAt: expires ? new Date(expires) : null, readable, certificate: null,
    pendingCertificate: pending === "none" ? null : view, pendingReadable: pending === "readable" });

describe("expiringSecrets", () => {
  it("warns from 30 days before expiry, and after", () => {
    expect(expiringSecrets([s("staff-microsoft", "2026-12-09T00:00:00Z")], now)).toHaveLength(0);
    expect(expiringSecrets([s("staff-microsoft", "2026-12-07T00:00:00Z")], now)).toHaveLength(1);
    expect(expiringSecrets([s("staff-microsoft", "2026-11-01T00:00:00Z")], now)).toHaveLength(1);
  });
  it("ignores secrets with no expiry date, and always warns about unreadable ones", () => {
    expect(expiringSecrets([s("parent-oidc", null)], now)).toHaveLength(0);
    expect(expiringSecrets([s("parent-oidc", null, false)], now)).toEqual([{ key: "parent-oidc", expiresAt: null, unreadable: true, pendingCertificate: false }]);
  });
  it("says whether a usable replacement certificate is already pending", () => {
    const soon = "2026-11-20T00:00:00Z";
    expect(expiringSecrets([s("staff-microsoft", soon, true, "readable")], now)[0]!.pendingCertificate).toBe(true);
    expect(expiringSecrets([s("staff-microsoft", soon, true, "unreadable")], now)[0]!.pendingCertificate).toBe(false);
    expect(expiringSecrets([s("staff-microsoft", soon)], now)[0]!.pendingCertificate).toBe(false);
  });
});

describe("certificateNextStep", () => {
  it("says to add the pending replacement and switch, or else to replace", () => {
    expect(certificateNextStep({ pendingCertificate: true }))
      .toBe("a replacement certificate is ready: add it to the app registration, then select Check and switch under Sign-in.");
    expect(certificateNextStep({ pendingCertificate: false })).toBe("Use Replace certificate under Sign-in.");
  });
});
