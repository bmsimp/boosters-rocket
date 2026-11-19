import { describe, it, expect, vi, afterEach } from "vitest";
import { checkPasswordRule, PASSWORD_MAX, PASSWORD_MIN } from "@/lib/parents/password-rule";

/**
 * The password rule of the sign-in release (open question 27 of the app-owned families spec): 12 to 128 characters,
 * any characters, nothing about symbols or mixing. It answers with a code and never logs or returns the password.
 */
describe("the password rule", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("is 12 to 128 characters", () => {
    expect([PASSWORD_MIN, PASSWORD_MAX]).toEqual([12, 128]);
    expect(checkPasswordRule("a".repeat(11))).toEqual({ ok: false, problem: "too_short" });
    expect(checkPasswordRule("a".repeat(12))).toEqual({ ok: true });
    expect(checkPasswordRule("a".repeat(128))).toEqual({ ok: true });
    expect(checkPasswordRule("a".repeat(129))).toEqual({ ok: false, problem: "too_long" });
    expect(checkPasswordRule("")).toEqual({ ok: false, problem: "too_short" });
    expect(checkPasswordRule("a".repeat(100_000))).toEqual({ ok: false, problem: "too_long" });
  });

  it("asks nothing about symbols, digits, case or mixing: any twelve characters will do", () => {
    for (const password of ["z".repeat(12), "correct horse battery", "123456789012", "ALLCAPSALLCAPS", " ".repeat(12), "tab\there\nand a line"]) {
      expect(checkPasswordRule(password), JSON.stringify(password)).toEqual({ ok: true });
    }
  });

  it("counts combined emoji and a decomposed accent as their code points, not as a person sees them", () => {
    // A thumbs-up with a skin tone is two code points: six of them look like six characters and count as twelve.
    const thumbs = String.fromCodePoint(0x1f44d, 0x1f3fd);
    expect([...thumbs].length).toBe(2);
    expect(checkPasswordRule(thumbs.repeat(6))).toEqual({ ok: true });
    // A family joined by zero-width joiners is five code points (three people and two joiners).
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect([...family].length).toBe(5);
    expect(checkPasswordRule(family.repeat(2))).toEqual({ ok: false, problem: "too_short" });
    expect(checkPasswordRule(family.repeat(3))).toEqual({ ok: true });
    // An e followed by a combining acute accent is two: ten letters and one such accented e count as twelve, while the
    // same letter written as one code point leaves them at eleven.
    const decomposed = String.fromCodePoint(0x65, 0x301);
    expect(decomposed.normalize("NFC")).toHaveLength(1);
    expect(checkPasswordRule(`abcdefghij${decomposed}`)).toEqual({ ok: true });
    expect(checkPasswordRule(`abcdefghij${decomposed.normalize("NFC")}`)).toEqual({ ok: false, problem: "too_short" });
  });

  it("counts characters by code point, and never trims or changes the password", () => {
    // Twelve emoji are twelve characters (24 UTF-16 units), and eleven are too few.
    expect(checkPasswordRule("🔑".repeat(12))).toEqual({ ok: true });
    expect(checkPasswordRule("🔑".repeat(11))).toEqual({ ok: false, problem: "too_short" });
    expect(checkPasswordRule("é".repeat(128))).toEqual({ ok: true });
    expect(checkPasswordRule("🔑".repeat(128))).toEqual({ ok: true });
    expect(checkPasswordRule("🔑".repeat(129))).toEqual({ ok: false, problem: "too_long" });
    // Spaces count: eleven letters with a space either side are thirteen characters.
    expect(checkPasswordRule(" abcdefghijk ")).toEqual({ ok: true });
    expect(checkPasswordRule(" abcdefghij")).toEqual({ ok: false, problem: "too_short" });
  });

  it("refuses anything the browser sent that isn't text", () => {
    for (const sent of [undefined, null, 123456789012, ["a".repeat(12)], { length: 12 }, true]) {
      expect(checkPasswordRule(sent)).toEqual({ ok: false, problem: "not_text" });
    }
  });

  it("never logs the password and never hands it back", () => {
    const logged: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); });
    const password = "a secret only I know";
    for (const tried of [password, password.slice(0, 5), password.repeat(10)]) {
      const verdict = checkPasswordRule(tried);
      expect(JSON.stringify(verdict)).not.toContain(tried.slice(0, 5));
      expect(Object.keys(verdict).sort()).toEqual(verdict.ok ? ["ok"] : ["ok", "problem"]);
    }
    expect(logged).toEqual([]);
  });
});
