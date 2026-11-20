import { describe, it, expect } from "vitest";
import { BACKUP_CODE_ALPHABET, BACKUP_CODE_COUNT, BACKUP_CODE_LENGTH, hashBackupCode, isBackupCodeShape, newBackupCode, normalizeBackupCode, readSecondStepCode, showBackupCode } from "@/lib/parents/backup-codes";

const PERSON = "6f3a9c1e-2b4d-4e8f-9a7b-1c2d3e4f5a6b";

describe("backup codes", () => {
  it("are ten of ten characters, from an alphabet with nothing easily read as another", () => {
    expect(BACKUP_CODE_COUNT).toBe(10);
    expect(BACKUP_CODE_LENGTH).toBe(10);
    expect(BACKUP_CODE_ALPHABET).toHaveLength(32);
    for (const ch of "IO01") expect(BACKUP_CODE_ALPHABET).not.toContain(ch);
    expect(new Set(BACKUP_CODE_ALPHABET).size).toBe(32);
  });

  it("are made of the alphabet, and shown with a dash between their halves", () => {
    for (let i = 0; i < 50; i++) {
      const code = newBackupCode();
      expect(code).toMatch(new RegExp(`^[${BACKUP_CODE_ALPHABET}]{10}$`));
      expect(showBackupCode(code)).toBe(`${code.slice(0, 5)}-${code.slice(5)}`);
      expect(normalizeBackupCode(showBackupCode(code))).toBe(code);
    }
  });

  it.each([
    ["ABCDE-FGHJK", "ABCDEFGHJK"], ["ABCDEFGHJK", "ABCDEFGHJK"], ["abcde-fghjk", "ABCDEFGHJK"],
    ["  abcde fghjk ", "ABCDEFGHJK"], ["AbCdE-23456", "ABCDE23456"],
  ])("read %j as %j: with or without its dash, in any case, spaces dropped", (typed, held) => {
    expect(normalizeBackupCode(typed)).toBe(held);
    expect(isBackupCodeShape(typed)).toBe(true);
  });

  it.each(["", "123456", "ABCDE-FGHJ", "ABCDE-FGHJKL", "ABCDE--FGHJK", "ABCD-EFGHJK", "ABCDE-FGHIK", "ABCDE-FGH0K", "ABCDEFGHJK-", "ÀBCDE-FGHJK"])(
    "are not %j", (typed) => {
      expect(normalizeBackupCode(typed)).toBeNull();
      expect(isBackupCodeShape(typed)).toBe(false);
    });

  it.each([
    ["123456", { kind: "app", code: "123456" }], ["123 456", { kind: "app", code: "123456" }], ["123-456", { kind: "app", code: "123456" }],
    [" 012 345 ", { kind: "app", code: "012345" }], ["012-345", { kind: "app", code: "012345" }], ["000000", { kind: "app", code: "000000" }],
    ["ABCDE-FGHJK", { kind: "backup", code: "ABCDEFGHJK" }], ["abcde fghjk", { kind: "backup", code: "ABCDEFGHJK" }],
    ["AB CDE-FG HJK", { kind: "backup", code: "ABCDEFGHJK" }], ["23456 78923", { kind: "backup", code: "2345678923" }],
    ["12345", { kind: "neither" }], ["1234567", { kind: "neither" }], ["12 34 5", { kind: "neither" }], ["1234-567", { kind: "neither" }],
    ["12345a", { kind: "neither" }], ["ABCDE-FGHIK", { kind: "neither" }], ["", { kind: "neither" }],
  ] as const)("a typed second step %j reads as %j: spaces and dashes dropped first", (typed, read) => {
    expect(readSecondStepCode(typed)).toEqual(read);
  });

  it("are held only as a keyed hash that names the person, never the code", () => {
    const h = hashBackupCode(PERSON, "ABCDEFGHJK");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("ABCDEFGHJK");
    expect(hashBackupCode(PERSON, "ABCDEFGHJK")).toBe(h);
    expect(hashBackupCode("00000000-0000-0000-0000-000000000000", "ABCDEFGHJK")).not.toBe(h);
    expect(hashBackupCode(PERSON, "ABCDEFGHJL")).not.toBe(h);
  });
});
