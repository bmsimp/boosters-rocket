import { describe, it, expect } from "vitest";
import { generateCode, formatCode, normalizeCode, hashCode, CODE_ALPHABET, CODE_LENGTH } from "@/lib/setup/code";

describe("setup code", () => {
  it("is 12 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it("is shown in groups of four", () => {
    expect(formatCode("K7QM2XPA9RTE")).toBe("K7QM-2XPA-9RTE");
  });
  it("ignores case, spaces and dashes when entered", () => {
    expect(normalizeCode(" k7qm-2xpa 9rte\n")).toBe("K7QM2XPA9RTE");
  });
  it("hashes with the salt", () => {
    expect(hashCode("K7QM2XPA9RTE", "a")).not.toBe(hashCode("K7QM2XPA9RTE", "b"));
    expect(hashCode("K7QM2XPA9RTE", "a")).toMatch(/^[0-9a-f]{64}$/);
  });
});
