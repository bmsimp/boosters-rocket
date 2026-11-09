import { describe, it, expect } from "vitest";
import { parseEnv } from "@/env";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  APP_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  SETTINGS_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
};

describe("SETTINGS_ENCRYPTION_KEY", () => {
  it("is required", () => {
    const rest: Partial<typeof base> = { ...base };
    delete rest.SETTINGS_ENCRYPTION_KEY;
    expect(() => parseEnv(rest)).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });
  it("must decode to 32 bytes", () => {
    expect(() => parseEnv({ ...base, SETTINGS_ENCRYPTION_KEY: Buffer.from("too short").toString("base64") }))
      .toThrow(/32 random bytes/);
  });
  it("treats an empty previous key as absent", () => {
    expect(parseEnv({ ...base, SETTINGS_ENCRYPTION_KEY_PREVIOUS: "" }).SETTINGS_ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
  });
});

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
