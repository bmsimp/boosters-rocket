import { describe, it, expect, vi } from "vitest";
import { ASK_MAX, bulkWords, eachRow, idsFrom, PRESS_MAX, ROW_FAILED } from "@/lib/bulk";

/** The bulk presses' shared rules (src/lib/bulk.ts): the ids a press takes, each row on its own, the cap, the words. */
describe("idsFrom", () => {
  const digits = (s: string) => /^\d+$/.test(s);
  it("keeps each id once, in order, and refuses anything a page doesn't send", () => {
    expect(idsFrom(["3", "1", "3", "2"], digits)).toEqual(["3", "1", "2"]);
    expect(idsFrom(["A1", "a1"], () => true)).toEqual(["A1"]);
    for (const raw of [[], "1", null, [1], ["1", "x"], Array.from({ length: ASK_MAX + 1 }, () => "1")]) expect(idsFrom(raw, digits), JSON.stringify(raw).slice(0, 30)).toBeNull();
    expect(idsFrom(Array.from({ length: ASK_MAX }, () => "1"), digits)).toEqual(["1"]);
  });
});

describe("eachRow", () => {
  it("does each row on its own: done, skipped with its words, failed when it throws, the others still done", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await eachRow(["a", "b", "c", "d"], (x) => x, async (x) => {
      if (x === "b") return { ok: false, errors: ["No.", "Not this one."] };
      if (x === "c") throw new Error("broken");
      return { ok: true, message: `${x} done` };
    });
    expect(r).toEqual({ left: [], rows: [{ id: "a", outcome: "done" }, { id: "b", outcome: "skipped", why: "No. Not this one." }, { id: "c", outcome: "failed", why: ROW_FAILED }, { id: "d", outcome: "done" }] });
  });

  it("skips the rest untried after a refusal every later row would meet", async () => {
    const tried: string[] = [];
    const r = await eachRow(["a", "b", "c"], (x) => x, async (x) => { tried.push(x); return x === "a" ? { ok: true, message: "" } : { ok: false, errors: ["Moved."] }; },
      { stop: (e) => e.includes("Moved."), why: (e) => `${e[0]}!` });
    expect(tried).toEqual(["a", "b"]);
    expect(r.rows).toEqual([{ id: "a", outcome: "done" }, { id: "b", outcome: "skipped", why: "Moved.!" }, { id: "c", outcome: "skipped", why: "Moved.!" }]);
  });

  it("tries at most PRESS_MAX rows and hands the rest back", async () => {
    const ids = Array.from({ length: PRESS_MAX + 3 }, (_, i) => String(i));
    const one = vi.fn(async () => ({ ok: true as const, message: "" }));
    const r = await eachRow(ids, (x) => x, one);
    expect(one).toHaveBeenCalledTimes(PRESS_MAX);
    expect(r.left).toEqual(ids.slice(PRESS_MAX));
    expect(bulkWords(r, "made")).toBe(`${PRESS_MAX} made. 3 more are still selected: up to ${PRESS_MAX} are done at a time.`);
  });
});

describe("bulkWords", () => {
  it("counts the rows by outcome", () => {
    expect(bulkWords({ rows: [{ id: "a", outcome: "done" }], left: [] }, "linked")).toBe("1 linked.");
    expect(bulkWords({ rows: [{ id: "a", outcome: "skipped", why: "" }, { id: "b", outcome: "failed", why: "" }], left: ["c"] }, "linked"))
      .toBe("0 linked, 1 skipped, 1 failed. 1 more is still selected: up to 200 are done at a time.");
  });
});
