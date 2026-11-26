/**
 * The selection a DataTable's tick boxes hold (BulkSelect), as plain functions so it can be tested alone. A selection
 * is the ids ticked on this page, or every row that matches (`allMatching`, once "Select all M that match" is chosen,
 * with the ids still unticked kept out). What a bulk action sends is `selectionPayload()`: ids, or "all that match"
 * with the ids left out. Either way it comes from the browser, so the server checks every id again against what the
 * person may change, and works out "all that match" from its own query, never from a count it was sent.
 */
export type Selection = { ids: ReadonlySet<string>; allMatching: boolean; except: ReadonlySet<string> };
export type HeaderState = "none" | "some" | "all";

export const NOTHING: Selection = { ids: new Set(), allMatching: false, except: new Set() };

const without = (s: ReadonlySet<string>, id: string) => { const n = new Set(s); n.delete(id); return n; };
const withId = (s: ReadonlySet<string>, id: string) => new Set(s).add(id);

export function isSelected(sel: Selection, id: string): boolean {
  return sel.allMatching ? !sel.except.has(id) : sel.ids.has(id);
}

/** Ticks or unticks one row. */
export function toggle(sel: Selection, id: string): Selection {
  const on = !isSelected(sel, id);
  if (sel.allMatching) return { ...sel, except: on ? without(sel.except, id) : withId(sel.except, id) };
  return { ...sel, ids: on ? withId(sel.ids, id) : without(sel.ids, id) };
}

/** Unticks these rows (after a bulk press, the ones it did), leaving every other as it is. */
export function untick(sel: Selection, ids: readonly string[]): Selection {
  if (ids.length === 0) return sel;
  if (sel.allMatching) return { ...sel, except: new Set([...sel.except, ...ids]) };
  const left = new Set(sel.ids);
  for (const id of ids) left.delete(id);
  return { ...sel, ids: left };
}

/** The header box: ticks every row on the page, or, when they all are already, unticks them (and leaves "all that match"). */
export function togglePage(sel: Selection, pageIds: readonly string[]): Selection {
  if (headerState(sel, pageIds) === "all") return NOTHING;
  if (sel.allMatching) return { ...sel, except: new Set() };
  return { ...sel, ids: new Set([...sel.ids, ...pageIds]) };
}

/** What the header box shows: none, some (the mixed state) or all of the page's rows ticked. */
export function headerState(sel: Selection, pageIds: readonly string[]): HeaderState {
  const n = pageIds.filter((id) => isSelected(sel, id)).length;
  return n === 0 ? "none" : n === pageIds.length ? "all" : "some";
}

/** Shift and a press: every row from the last one pressed to this one takes this one's new state. */
export function selectRange(sel: Selection, pageIds: readonly string[], anchor: string, id: string): Selection {
  const a = pageIds.indexOf(anchor), b = pageIds.indexOf(id);
  if (a < 0 || b < 0) return toggle(sel, id);
  const on = !isSelected(sel, id);
  let next = sel;
  for (const x of pageIds.slice(Math.min(a, b), Math.max(a, b) + 1)) if (isSelected(next, x) !== on) next = toggle(next, x);
  return next;
}

/** Every row that matches, not only this page's. */
export function selectAllMatching(): Selection {
  return { ids: new Set(), allMatching: true, except: new Set() };
}

/** How many rows are selected, out of `total` that match. */
export function selectedCount(sel: Selection, total: number): number {
  return sel.allMatching ? Math.max(0, total - sel.except.size) : sel.ids.size;
}

/** Whether to offer "Select all M that match": the whole page is ticked and more rows match than it shows. */
export function offersAllMatching(sel: Selection, pageIds: readonly string[], total: number): boolean {
  return !sel.allMatching && total > pageIds.length && headerState(sel, pageIds) === "all";
}

/** What a bulk action sends. The server checks it all again. */
export function selectionPayload(sel: Selection): { ids: string[] } | { allMatching: true; except: string[] } {
  return sel.allMatching ? { allMatching: true, except: [...sel.except] } : { ids: [...sel.ids] };
}
