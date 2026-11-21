import { describe, it, expect } from "vitest";
import { CODE_STEP_KEY, CODE_STEP_LIFE_MS, clearCodeStep, loadCodeStep, saveCodeStep, type CodeStepStore } from "@/app/sign-in/code-step";
import { CODE_TTL_MS } from "@/lib/parents/signin-codes";

/** A browser store, as far as the code step uses one. */
function memoryStore(initial: Record<string, string> = {}): CodeStepStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}
const brokenStore: CodeStepStore = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};
const T = Date.parse("2026-11-15T18:00:00Z");

describe("the code step kept on the device", () => {
  it("lives exactly as long as the code, and the pending step, do", () => {
    expect(CODE_STEP_LIFE_MS).toBe(CODE_TTL_MS);
  });

  it("is picked up after a reload: when the code was sent and the page asked for, and never the address", () => {
    const store = memoryStore();
    saveCodeStep(store, { sentAt: T, next: "/payments", kind: "code" });
    expect(loadCodeStep(store, T + 45_000)).toEqual({ sentAt: T, next: "/payments", kind: "code" });
    expect(loadCodeStep(store, T + CODE_STEP_LIFE_MS - 1)).toEqual({ sentAt: T, next: "/payments", kind: "code" });
    // Only what the form needs is kept, under one key.
    expect(Object.keys(store.data)).toEqual([CODE_STEP_KEY]);
    expect(JSON.parse(store.data[CODE_STEP_KEY]!)).toEqual({ sentAt: T, next: "/payments", kind: "code" });
    // An address left by an older build is not read back, and a new step never writes one.
    expect(store.data[CODE_STEP_KEY]).not.toContain("@");
  });

  it("is dropped, and removed from the device, once the code's 10 minutes are over", () => {
    const store = memoryStore();
    saveCodeStep(store, { sentAt: T, next: null, kind: "code" });
    expect(loadCodeStep(store, T + CODE_STEP_LIFE_MS)).toBeNull();
    expect(store.data).toEqual({});
  });

  it("is removed on sign-in and on 'Start again'", () => {
    const store = memoryStore();
    saveCodeStep(store, { sentAt: T, next: null, kind: "code" });
    clearCodeStep(store);
    expect(store.data).toEqual({});
    expect(loadCodeStep(store, T + 1)).toBeNull();
  });

  it.each([
    ["not JSON", "{oops"],
    ["null", "null"],
    ["a string", JSON.stringify("ana@example.com")],
    ["a list", JSON.stringify([T])],
    ["no time", JSON.stringify({ next: "/payments" })],
    ["a time that is text", JSON.stringify({ sentAt: String(T) })],
    ["a time in the future", JSON.stringify({ sentAt: T + 60_000 })],
    ["a time long ago", JSON.stringify({ sentAt: 0 })],
  ])("drops and removes what it can't use: %s", (_what, stored) => {
    const store = memoryStore({ [CODE_STEP_KEY]: stored });
    expect(loadCodeStep(store, T + 1000)).toBeNull();
    expect(store.data).toEqual({});
  });

  it.each(["//evil.example", "https://evil.example/", "/staff/roster", "/\\evil.example", 7, { path: "/display" }])(
    "keeps the step and forgets a page that is not a parent page of this site: %s", (next) => {
      const store = memoryStore({ [CODE_STEP_KEY]: JSON.stringify({ sentAt: T, next }) });
      expect(loadCodeStep(store, T + 1000)).toEqual({ sentAt: T, next: null, kind: "code" });
    });

  it("picks up a step an older build kept with the address, and never gives the address back", () => {
    const store = memoryStore({ [CODE_STEP_KEY]: JSON.stringify({ email: "ana@example.com", sentAt: T, next: null }) });
    expect(loadCodeStep(store, T + 1000)).toEqual({ sentAt: T, next: null, kind: "code" });
  });

  it("keeps which second step it was, so a reload draws the app step again (slice SI-6a)", () => {
    const store = memoryStore();
    saveCodeStep(store, { sentAt: T, next: "/forms", kind: "app" });
    expect(loadCodeStep(store, T + 1000)).toEqual({ sentAt: T, next: "/forms", kind: "app" });
    expect(JSON.parse(store.data[CODE_STEP_KEY]!)).toEqual({ sentAt: T, next: "/forms", kind: "app" });
  });

  it("keeps the passkey step with whether the app is offered beside it, so a reload draws it again (slice SI-7a)", () => {
    for (const app of [true, false]) {
      const store = memoryStore();
      saveCodeStep(store, { sentAt: T, next: "/forms", kind: "passkey", app });
      expect(loadCodeStep(store, T + 1000)).toEqual({ sentAt: T, next: "/forms", kind: "passkey", app });
    }
  });

  it.each([["no kind (an older build's)", undefined], ["a kind it doesn't know", "security-key"], ["a passkey's kind with no app bit", "passkey"],
    ["a kind that is not text", 1], ["the code's own", "code"]])(
    "reads a step with %s as the code step", (_what, kind) => {
      const store = memoryStore({ [CODE_STEP_KEY]: JSON.stringify({ sentAt: T, next: null, kind }) });
      expect(loadCodeStep(store, T + 1000)).toEqual({ sentAt: T, next: null, kind: "code" });
    });

  it("keeps a passkey step's backup-code field, so a reload offers it again, and reads anything but true as none (slice SI-7b)", () => {
    const store = memoryStore();
    saveCodeStep(store, { sentAt: T, next: null, kind: "passkey", app: false, backup: true });
    expect(loadCodeStep(store, T + 1000)).toEqual({ sentAt: T, next: null, kind: "passkey", app: false, backup: true });
    for (const backup of [false, "yes", 1]) {
      const odd = memoryStore({ [CODE_STEP_KEY]: JSON.stringify({ sentAt: T, next: null, kind: "passkey", app: false, backup }) });
      expect(loadCodeStep(odd, T + 1000)).toEqual({ sentAt: T, next: null, kind: "passkey", app: false });
    }
  });

  it("reads a passkey step whose app bit is not true or false as the code step", () => {
    const store = memoryStore({ [CODE_STEP_KEY]: JSON.stringify({ sentAt: T, next: null, kind: "passkey", app: "yes" }) });
    expect(loadCodeStep(store, T + 1000)).toEqual({ sentAt: T, next: null, kind: "code" });
  });

  it("does without a store that is missing or throws", () => {
    for (const store of [null, brokenStore]) {
      expect(() => saveCodeStep(store, { sentAt: T, next: null, kind: "code" })).not.toThrow();
      expect(loadCodeStep(store, T + 1)).toBeNull();
      expect(() => clearCodeStep(store)).not.toThrow();
    }
  });
});
