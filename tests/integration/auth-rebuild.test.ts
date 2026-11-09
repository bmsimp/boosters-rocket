import { describe, it, expect, beforeEach } from "vitest";
import { getStaffAuth } from "@/lib/auth/staff-auth";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { resetDb, seedProvider } from "../helpers/db";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";

describe("sign-in built from stored providers", () => {
  beforeEach(resetDb);

  it("has no providers before setup", async () => {
    expect(Object.keys((await getStaffAuth()).options.socialProviders ?? {})).toEqual([]);
    expect((await getParentAuth()).options.plugins ?? []).toHaveLength(0);
  });

  it("is reused until a save, then rebuilt with the new provider", async () => {
    const first = await getStaffAuth();
    expect(await getStaffAuth()).toBe(first);
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C }, "ms-secret");
    const second = await getStaffAuth();
    expect(second).not.toBe(first);
    expect(second.options.socialProviders).toMatchObject({ microsoft: { clientId: C, tenantId: T, clientSecret: "ms-secret" } });
  });

  it("turns the parent door on when the parent provider is stored", async () => {
    await seedProvider("parent-oidc", { tenantSubdomain: "fznparents", tenantId: T, clientId: C });
    expect((await getParentAuth()).options.plugins ?? []).toHaveLength(1);
  });
});
