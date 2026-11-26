import { describe, it, expect } from "vitest";
import {
  NOTHING, headerState, isSelected, offersAllMatching, selectAllMatching, selectRange, selectedCount, selectionPayload, toggle, togglePage,
} from "@/app/components/ui/selection";

const PAGE = ["a", "b", "c", "d"];

describe("bulk selection", () => {
  it("ticks and unticks one row, and the header follows: none, some (mixed), all", () => {
    let s = toggle(NOTHING, "b");
    expect(isSelected(s, "b")).toBe(true);
    expect(headerState(s, PAGE)).toBe("some");
    for (const id of ["a", "c", "d"]) s = toggle(s, id);
    expect(headerState(s, PAGE)).toBe("all");
    s = toggle(s, "a");
    expect(headerState(s, PAGE)).toBe("some");
    expect(headerState(NOTHING, PAGE)).toBe("none");
  });

  it("the header ticks the whole page, and pressed again with all ticked, clears it", () => {
    const some = toggle(NOTHING, "c");
    const all = togglePage(some, PAGE);
    expect(PAGE.every((id) => isSelected(all, id))).toBe(true);
    expect(togglePage(all, PAGE)).toEqual(NOTHING);
  });

  it("offers every row that matches only when the whole page is ticked and more match than it shows", () => {
    const all = togglePage(NOTHING, PAGE);
    expect(offersAllMatching(all, PAGE, 4)).toBe(false);
    expect(offersAllMatching(all, PAGE, 12)).toBe(true);
    expect(offersAllMatching(toggle(all, "a"), PAGE, 12)).toBe(false);
    expect(offersAllMatching(selectAllMatching(), PAGE, 12)).toBe(false);
  });

  it("all that match: counted from the total, a row unticked is left out, and that is what is sent", () => {
    let s = selectAllMatching();
    expect(selectedCount(s, 12)).toBe(12);
    s = toggle(s, "b");
    expect(isSelected(s, "b")).toBe(false);
    expect(selectedCount(s, 12)).toBe(11);
    expect(headerState(s, PAGE)).toBe("some");
    expect(selectionPayload(s)).toEqual({ allMatching: true, except: ["b"] });
    expect(togglePage(s, PAGE)).toEqual(selectAllMatching());
  });

  it("sends the ids ticked, and nothing else", () => {
    const s = toggle(toggle(NOTHING, "d"), "a");
    expect(selectedCount(s, 12)).toBe(2);
    expect(selectionPayload(s)).toEqual({ ids: ["d", "a"] });
  });

  it("Shift and a press ticks the run from the last row pressed, either way, to this row's new state", () => {
    const one = toggle(NOTHING, "a");
    const run = selectRange(one, PAGE, "a", "c");
    expect(PAGE.map((id) => isSelected(run, id))).toEqual([true, true, true, false]);
    const off = selectRange(run, PAGE, "d", "b"); // b was ticked, so the run from d to b is unticked
    expect(PAGE.map((id) => isSelected(off, id))).toEqual([true, false, false, false]);
    const on = selectRange(off, PAGE, "d", "c");
    expect(PAGE.map((id) => isSelected(on, id))).toEqual([true, false, true, true]);
    expect(selectRange(NOTHING, PAGE, "zz", "b")).toEqual(toggle(NOTHING, "b"));
  });
});
