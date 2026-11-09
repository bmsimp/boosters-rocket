import { describe, it, expect } from "vitest";
import { signSetupSession, verifySetupSession, SETUP_SESSION_MS } from "@/lib/setup/session";

const SECRET = "test-secret-test-secret-test-secret-32";
const HASH = "ab".repeat(32);

describe("setup session cookie", () => {
  const now = 1_800_000_000_000;
  it("verifies its own value", () => {
    expect(verifySetupSession(signSetupSession(HASH, now, SECRET), HASH, now + 1000, SECRET)).toBe(true);
  });
  it("a setup session survives a restart (depends only on the code hash and the secret)", () => {
    const value = signSetupSession(HASH, now, SECRET);
    expect(verifySetupSession(value, HASH, now + 60_000, SECRET)).toBe(true);
  });
  it("expires after two hours", () => {
    expect(verifySetupSession(signSetupSession(HASH, now, SECRET), HASH, now + SETUP_SESSION_MS + 1, SECRET)).toBe(false);
  });
  it("dies when a new code is issued", () => {
    expect(verifySetupSession(signSetupSession(HASH, now, SECRET), "cd".repeat(32), now, SECRET)).toBe(false);
  });
  it("refuses tampering and junk", () => {
    const [at, mac] = signSetupSession(HASH, now, SECRET).split(".");
    expect(verifySetupSession(`${Number(at) + 1}.${mac}`, HASH, now, SECRET)).toBe(false);
    expect(verifySetupSession("junk", HASH, now, SECRET)).toBe(false);
    expect(verifySetupSession(undefined, HASH, now, SECRET)).toBe(false);
  });
});
