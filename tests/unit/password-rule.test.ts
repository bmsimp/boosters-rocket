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

  it("counts characters as a person does, by code point, and never trims or changes the password", () => {
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
