import { describe, it, expect } from "vitest";
import { TOTP_STEP_SECONDS, base32Decode, base32Encode, hotp, matchTotp, totp, totpStep } from "@/lib/parents/totp";

// The standards' own published values: RFC 4648 section 10, RFC 4226 Appendix D, RFC 6238 Appendix B (SHA-1).
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("base32 (RFC 4648)", () => {
  // Section 10's vectors, with their padding taken off: the portal writes none.
  const VECTORS: [string, string][] = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];

  it.each(VECTORS)("encodes %j as %j, upper case with no padding", (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, "ascii"))).toBe(encoded);
  });

  it.each(VECTORS)("decodes %j back from %j, with or without padding, in either case", (plain, encoded) => {
    expect(base32Decode(encoded)!.toString("ascii")).toBe(plain);
    expect(base32Decode(encoded.toLowerCase())!.toString("ascii")).toBe(plain);
    const padded = encoded + "=".repeat((8 - (encoded.length % 8)) % 8);
    expect(base32Decode(padded)!.toString("ascii")).toBe(plain);
  });

  it("reads twenty random bytes back as they were", () => {
    const bytes = Buffer.from("8f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", "hex");
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(bytes)).toHaveLength(32);
  });

  it.each(["MZXW6YQ1", "MZXW 6YQ", "MZXW-6YQ", "MZ=XW"])("refuses what isn't base32: %j", (text) => {
    expect(base32Decode(text)).toBeNull();
  });
});

describe("HOTP (RFC 4226)", () => {
  it("gives Appendix D's ten values for its secret", () => {
    const values = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expect(values.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(values);
  });
});

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
  ])("gives Appendix B's SHA-1 value at %i seconds, at 8 digits", (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });

  it("asks for 6 digits by default: the last six of the 8-digit value", () => {
    expect(totp(RFC_SECRET, 59_000)).toBe("287082");
    expect(totp(RFC_SECRET, new Date(1111111109_000))).toBe("081804");
  });

  it("counts 30-second steps from the Unix epoch", () => {
    expect(TOTP_STEP_SECONDS).toBe(30);
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
    expect(totpStep(new Date(59_000))).toBe(1);
  });
});

describe("matching a typed code", () => {
  const at = 1_800_000_000_000; // a moment well inside its step
  const step = totpStep(at);
  const codeAt = (s: number) => hotp(RFC_SECRET, s);

  it("takes the code of the step now, and answers that step", () => {
    expect(matchTotp(RFC_SECRET, codeAt(step), at)).toBe(step);
  });

  it("takes the step before and the step after, for a clock one step off", () => {
    expect(matchTotp(RFC_SECRET, codeAt(step - 1), at)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, codeAt(step + 1), at)).toBe(step + 1);
  });

  it("refuses a code two steps away either way", () => {
    expect(matchTotp(RFC_SECRET, codeAt(step - 2), at)).toBeNull();
    expect(matchTotp(RFC_SECRET, codeAt(step + 2), at)).toBeNull();
  });

  it.each(["", "12345", "1234567", "12345a", " 123456", "１２３４５６"])("refuses what isn't six digits: %j", (typed) => {
    expect(matchTotp(RFC_SECRET, typed, at)).toBeNull();
  });

  it("refuses another secret's code", () => {
    const other = Buffer.from("abcdefghijabcdefghij", "ascii");
    const code = hotp(other, step);
    if (code !== codeAt(step - 1) && code !== codeAt(step) && code !== codeAt(step + 1)) expect(matchTotp(RFC_SECRET, code, at)).toBeNull();
  });
});
