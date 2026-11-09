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
