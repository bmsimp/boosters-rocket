import { describe, it, expect } from "vitest";
import { parseEnv } from "@/env";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  APP_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  SETTINGS_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
};

describe("CLIENT_IP_HEADER", () => {
  it("is Cloudflare's header when it is not set or is left empty", () => {
    expect(parseEnv(base).CLIENT_IP_HEADER).toBe("cf-connecting-ip");
    expect(parseEnv({ ...base, CLIENT_IP_HEADER: "" }).CLIENT_IP_HEADER).toBe("cf-connecting-ip");
    expect(parseEnv({ ...base, CLIENT_IP_HEADER: "   " }).CLIENT_IP_HEADER).toBe("cf-connecting-ip");
  });
  it.each([["X-Forwarded-For", "x-forwarded-for"], [" x-real-ip ", "x-real-ip"], ["Fly-Client-IP", "fly-client-ip"], ["NONE", "none"]])(
    "takes %j as %j", (given, kept) => expect(parseEnv({ ...base, CLIENT_IP_HEADER: given }).CLIENT_IP_HEADER).toBe(kept));
  it.each(["x-forwarded-for, x-real-ip", "x forwarded for", "x-forwarded-for:", "*", "-x", "x_real_ip", "x-booster-client-ip", "X-Booster-Client-IP", "a".repeat(65)])(
    "refuses %j, saying what it should be", (given) => expect(() => parseEnv({ ...base, CLIENT_IP_HEADER: given })).toThrow(/one header name/));
});

describe("APP_URL", () => {
  it.each(["https://portal.yourclub.org", "https://portal.yourclub.org/", "http://localhost:3000", "https://portal.yourclub.org:8443", " https://portal.yourclub.org "])(
    "takes %j", (given) => expect(parseEnv({ ...base, APP_URL: given }).APP_URL).toBe(given.trim()));
  it.each(["portal.yourclub.org", "https://portal.yourclub.org/portal", "https://portal.yourclub.org/?a=1", "https://portal.yourclub.org/#top",
    "https://user:pass@portal.yourclub.org", "ftp://portal.yourclub.org", "javascript:alert(1)", ""])(
    "refuses %j: the portal's address and nothing more", (given) => expect(() => parseEnv({ ...base, APP_URL: given })).toThrow(/APP_URL/));
  it("is required", () => {
    const rest: Partial<typeof base> = { ...base };
    delete rest.APP_URL;
    expect(() => parseEnv(rest)).toThrow(/APP_URL/);
  });
});

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
