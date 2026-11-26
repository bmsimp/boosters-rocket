"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Sheet } from "./sheet";
import {
  NOTHING, headerState, isSelected, offersAllMatching, selectAllMatching, selectRange, selectedCount, toggle, togglePage, untick, type Selection,
} from "./selection";

/**
 * Bulk select for a DataTable: a tick box on every row (`select` on DataTable draws them), one in the header with the
 * mixed state, and a bar that stays in view while anything is ticked: "N selected", the actions, and Clear, its count
 * read out as it changes. When the page shows fewer rows than match, ticking the header offers "Select all M that
 * match". On a phone the actions fold into one "N selected · Actions" button that opens a Drawer of them. Everything
 * works from the keyboard (Space ticks a box); Shift and a press ticks a run of rows.
 *
 * The actions are client components given as `actions`, reading the selection with useBulkSelection(). What one sends
 * is selectionPayload(): ids from the browser, which the server checks again, every one, before it acts.
 */
type Bulk = {
  selection: Selection; pageIds: readonly string[]; total: number; count: number;
  toggleRow: (id: string, range: boolean) => void; togglePage: () => void; clear: () => void;
  /** Unticks these rows, leaving every other as it is: after a bulk press, the ones it did. */
  untick: (ids: readonly string[]) => void;
};
const BulkContext = createContext<Bulk | null>(null);

export function useBulkSelection(): Bulk {
  const b = useContext(BulkContext);
  if (!b) throw new Error("useBulkSelection() is for a component inside BulkSelect.");
  return b;
}

export function BulkSelect({ pageIds, total, noun, actions, children }: {
  pageIds: string[]; total?: number; noun: { one: string; many: string }; actions: ReactNode; children: ReactNode;
}) {
  const all = total ?? pageIds.length;
  const [selection, setSelection] = useState<Selection>(NOTHING);
  const [menu, setMenu] = useState(false);
  const anchor = useRef<string | null>(null);
  const count = selectedCount(selection, all);
  const bulk: Bulk = {
    selection, pageIds, total: all, count,
    toggleRow: (id, range) => {
      setSelection((s) => (range && anchor.current ? selectRange(s, pageIds, anchor.current, id) : toggle(s, id)));
      anchor.current = id;
    },
    togglePage: () => setSelection((s) => togglePage(s, pageIds)),
    clear: () => { setSelection(NOTHING); setMenu(false); },
    untick: (ids) => setSelection((s) => untick(s, ids)),
  };
  const words = `${count} ${count === 1 ? noun.one : noun.many} selected`;
  return (
    <BulkContext.Provider value={bulk}>
      <div className="bulk">
        {children}
        <div className="bulk-bar" hidden={count === 0}>
          <p className="bulk-count" aria-live="polite">{count > 0 ? words : ""}</p>
          {offersAllMatching(selection, pageIds, all) && (
            <p className="bulk-all">All {pageIds.length} on this page are selected.{" "}
              <Button variant="quiet" size="sm" onClick={() => setSelection(selectAllMatching())}>Select all {all} that match</Button></p>
          )}
          {selection.allMatching && <p className="bulk-all">All {all} that match are selected.</p>}
          <div className="bulk-actions">{actions}</div>
          <Button variant="secondary" size="sm" className="bulk-menu" onClick={() => setMenu(true)}>{count} selected · Actions</Button>
          <Button variant="quiet" size="sm" onClick={bulk.clear}>Clear</Button>
        </div>
        <Sheet open={menu && count > 0} onClose={() => setMenu(false)} title={words}>
          <div className="stack">{actions}</div>
        </Sheet>
      </div>
    </BulkContext.Provider>
  );
}

/** A row's tick box, labelled "Select {the row's name}". */
export function RowCheck({ id, label }: { id: string; label: string }) {
  const b = useBulkSelection();
  const shift = useRef(false);
  return (
    <span className="checks bulk-check"><label><input type="checkbox" checked={isSelected(b.selection, id)}
      onClick={(e) => { shift.current = e.shiftKey; }} onChange={() => { b.toggleRow(id, shift.current); shift.current = false; }} />
      <span className="visually-hidden">{label}</span></label></span>
  );
}

/** The header's tick box: every row on the page, mixed when some are ticked. */
export function HeaderCheck({ label = "Select every row on this page" }: { label?: string }) {
  const b = useBulkSelection();
  const ref = useRef<HTMLInputElement>(null);
  const state = headerState(b.selection, b.pageIds);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "some"; }, [state]);
  if (b.pageIds.length === 0) return null; // no row on the page can be ticked
  return (
    <span className="checks bulk-check"><label><input ref={ref} type="checkbox" checked={state === "all"} aria-checked={state === "some" ? "mixed" : state === "all"}
      onChange={b.togglePage} /><span className="visually-hidden">{label}</span></label></span>
  );
}
