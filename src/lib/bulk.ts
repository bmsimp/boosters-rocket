// Bulk presses on many rows at once (the QuickBooks setup screens: Accounting links' Link to their suggested families
// and Create families, Reconciliation's Try again and Give up). What a press sends comes from the browser: the ids the
// person ticked, which this module checks for their type, count and format only. Every row is then done by the single
// row's own library function, in its own transaction with its own audit row, so the rules of a bulk press and of the
// row's own button can't drift apart, and one row refused or failing never undoes another. At most PRESS_MAX rows are
// tried in one press; the rest are handed back, untried, for the next.

/** At most this many rows are tried in one press. */
export const PRESS_MAX = 200;
/** At most this many ids are taken from the browser in one press (the rows past PRESS_MAX are handed back untried). */
export const ASK_MAX = 2000;

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
/** One row's outcome: done, skipped with a plain reason (the single press's refusal), or failed (it threw). */
export type RowDone = { id: string; outcome: "done" } | { id: string; outcome: "skipped" | "failed"; why: string };
/**
 * A bulk press's answer: each row tried, in the order sent, and the ids left untried past the cap (`left`), for the next
 * press. Or a refusal of the whole press before any row was tried (its arguments weren't ones a page sends).
 */
export type BulkDone = { ok: true; message: string; rows: RowDone[]; left: string[] } | { ok: false; errors: string[] };

/** Said for a row whose press threw: nothing of it was kept, its transaction having been rolled back. */
export const ROW_FAILED = "Something went wrong with this one, and nothing was changed for it. Try it on its own.";

/**
 * The ids a press sent, checked for their type, count and format, each kept once (the first spelling), in order: null
 * for anything a page doesn't send (not a list, empty, more than ASK_MAX, or an id `valid` refuses).
 */
export function idsFrom(raw: unknown, valid: (id: string) => boolean): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ASK_MAX) return null;
  const seen = new Set<string>(), ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !valid(v)) return null;
    const key = v.toLowerCase();
    if (!seen.has(key)) { seen.add(key); ids.push(v); }
  }
  return ids;
}

/**
 * Does each of the first PRESS_MAX items by the single row's press (`one`), one after the other, each its own
 * transaction: done, skipped with the refusal's words (`why`, which may shorten them), or failed when it threw. A
 * refusal `stop` names (one every later row would meet too: the roster read from another company, the roster lock
 * busy) skips the rest with the same words, untried.
 */
export async function eachRow<T>(items: readonly T[], idOf: (item: T) => string, one: (item: T) => Promise<Done>,
  o: { why?: (errors: string[]) => string; stop?: (errors: string[]) => boolean } = {}): Promise<{ rows: RowDone[]; left: string[] }> {
  const why = o.why ?? ((errors: string[]) => errors.join(" "));
  const now = items.slice(0, PRESS_MAX);
  const rows: RowDone[] = [];
  let stopped: string | null = null;
  for (const item of now) {
    const id = idOf(item);
    if (stopped !== null) { rows.push({ id, outcome: "skipped", why: stopped }); continue; }
    let r: Done;
    try {
      r = await one(item);
    } catch (e) {
      console.error("A row of a bulk press failed:", e);
      rows.push({ id, outcome: "failed", why: ROW_FAILED });
      continue;
    }
    if (r.ok) { rows.push({ id, outcome: "done" }); continue; }
    rows.push({ id, outcome: "skipped", why: why(r.errors) });
    if (o.stop?.(r.errors)) stopped = why(r.errors);
  }
  return { rows, left: items.slice(PRESS_MAX).map(idOf) };
}

/** "10 linked, 2 skipped, 1 failed.", with "N more are still selected" when the cap left some untried. */
export function bulkWords(r: { rows: readonly RowDone[]; left: readonly string[] }, done: string): string {
  const n = (k: RowDone["outcome"]) => r.rows.filter((x) => x.outcome === k).length;
  const parts = [`${n("done")} ${done}`];
  if (n("skipped") > 0) parts.push(`${n("skipped")} skipped`);
  if (n("failed") > 0) parts.push(`${n("failed")} failed`);
  const said = `${parts.join(", ")}.`;
  return r.left.length === 0 ? said : `${said} ${r.left.length} more ${r.left.length === 1 ? "is" : "are"} still selected: up to ${PRESS_MAX} are done at a time.`;
}
