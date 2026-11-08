import { describe, it, expect } from "vitest";
import { parseEnv } from "@/env";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "x".repeat(32) };

describe("STAFF_ENTRA_TENANT_ID", () => {
  it.each(["common", "organizations", "consumers"])("rejects the multi-tenant alias %s", (v) => {
    expect(() => parseEnv({ ...base, STAFF_ENTRA_TENANT_ID: v })).toThrow(/tenant\) GUID/);
  });
  it("accepts a directory GUID", () => {
    expect(parseEnv({ ...base, STAFF_ENTRA_TENANT_ID: "0f8fad5b-d9cb-469f-a165-70867728950e" }).STAFF_ENTRA_TENANT_ID).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
  });
  it("allows it to be unset or blank", () => {
    expect(parseEnv(base).STAFF_ENTRA_TENANT_ID).toBeUndefined();
    expect(parseEnv({ ...base, STAFF_ENTRA_TENANT_ID: "" }).STAFF_ENTRA_TENANT_ID).toBeUndefined();
  });
});
