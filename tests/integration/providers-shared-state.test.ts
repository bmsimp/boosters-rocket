import { describe, it, expect, vi } from "vitest";
import * as original from "@/lib/auth/providers";

describe("provider cache state", () => {
  it("is shared between separately loaded copies of the module", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/auth/providers");
    expect(fresh).not.toBe(original);
    expect(fresh.providersVersion()).toBe(original.providersVersion());
    fresh.invalidateProviders();
    expect(original.providersVersion()).toBe(fresh.providersVersion());
    original.invalidateProviders();
    expect(fresh.providersVersion()).toBe(original.providersVersion());
  });
});
