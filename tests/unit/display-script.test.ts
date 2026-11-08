import { describe, it, expect } from "vitest";
import { DISPLAY_SCRIPT } from "@/app/display-script";

function run(saved: unknown, getItem?: (k: string) => string | null) {
  const attrs = new Map<string, string>();
  const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
  const store = new Map<string, string>(saved === undefined ? [] : [["br-display", JSON.stringify(saved)]]);
  const fn = new Function("document", "localStorage", "window", DISPLAY_SCRIPT);
  const win: Record<string, unknown> = {};
  fn({ documentElement: root }, { getItem: getItem ?? ((k: string) => store.get(k) ?? null), setItem: (k: string, v: string) => store.set(k, v) }, win);
  return { attrs, win: win as { BoosterDisplay: { set(k: string, v: string): void } }, store };
}

describe("display script", () => {
  it("sets nothing when following the device", () => {
    expect([...run(undefined).attrs]).toEqual([]);
  });
  it("applies saved overrides", () => {
    expect(Object.fromEntries(run({ theme: "dark", contrast: "more", text: "larger", motion: "reduce" }).attrs)).toEqual(
      { "data-theme": "dark", "data-contrast": "more", "data-text": "larger", "data-motion": "reduce" });
  });
  it("ignores junk values", () => {
    expect([...run({ theme: "purple", text: "huge" }).attrs]).toEqual([]);
  });
  it("copes with unparseable storage", () => {
    expect([...run(undefined, () => "{").attrs]).toEqual([]);
  });
  it("copes with storage that throws", () => {
    expect([...run(undefined, () => { throw new Error("blocked"); }).attrs]).toEqual([]);
  });
  it("saves and applies a change", () => {
    const r = run(undefined);
    r.win.BoosterDisplay.set("theme", "light");
    expect(r.attrs.get("data-theme")).toBe("light");
    expect(JSON.parse(r.store.get("br-display")!)).toEqual({ theme: "light" });
  });
});
