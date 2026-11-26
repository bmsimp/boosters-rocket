"use client";
import { createContext, startTransition, useContext, useId, useState, type ReactNode } from "react";
import { ACTION_FAILED, safely } from "../action-error";
import { ActionOutcome, Notice } from "../notice";
import { Button, type ButtonVariant } from "./button";
import { TextArea } from "./field";
import { Sheet } from "./sheet";
import { useBulkSelection } from "./bulk-select";

/** What a bulk press answers (src/lib/bulk.ts's BulkDone): every row tried, and the ids it left untried past its cap. */
export type BulkAnswer =
  | { ok: true; message: string; rows: ({ id: string; outcome: "done" } | { id: string; outcome: "skipped" | "failed"; why: string })[]; left: string[] }
  | { ok: false; errors: string[] };
type Tried = Extract<BulkAnswer, { ok: true }>;

/** A press's answer as its Drawer shows it, row by row, with what "Do the next N" sends. */
type Shown = {
  title: string; answer: Tried; names: ReadonlyMap<string, string>; done: string; variant: ButtonVariant; busyLabel: string; cap: number;
  /** Sends the ids not tried yet, and hands the answer back to the action's own list (to leave the rows not done ticked). */
  next: (ids: string[]) => Promise<BulkAnswer>;
};
const Results = createContext<((s: Shown) => void) | null>(null);

/**
 * Holds what a bulk press did, row by row, in its own Drawer, drawn at the page's level: a press re-reads the page, and
 * its rows (its list, the whole part when it was the last) may go, taking their BulkSelect and its action with them.
 * Wrap the page's content in it; without it, each action shows its answer in its own Drawer, while it stays drawn.
 */
export function BulkResults({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  return (
    <Results.Provider value={setShown}>
      {children}
      <ResultsSheet shown={shown} onClose={() => setShown(null)} onNext={setShown} />
    </Results.Provider>
  );
}

function ResultsSheet({ shown, onClose, onNext }: { shown: Shown | null; onClose: () => void; onNext: (s: Shown) => void }) {
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<BulkAnswer | null>(null);
  const s = shown;
  const more = () => {
    if (!s || pending) return;
    setPending(true);
    setRefused(null);
    startTransition(async () => {
      const r = await s.next(s.answer.left);
      setPending(false);
      if (r.ok) onNext({ ...s, answer: r }); else setRefused(r);
    });
  };
  const tried = s?.answer;
  return (
    <Sheet open={s !== null} onClose={() => { if (!pending) { setRefused(null); onClose(); } }} title={s?.title ?? ""}>
      {s && tried && (
        <div className="stack">
          <Notice tone={tried.rows.every((x) => x.outcome === "done") && tried.left.length === 0 ? "done" : "warning"}>{tried.message}</Notice>
          <ul>{tried.rows.map((x) => (
            <li key={x.id}>{s.names.get(x.id) ?? "A row no longer shown"}: {x.outcome === "done" ? s.done : x.outcome === "skipped" ? `Skipped. ${x.why}` : `Didn't go through. ${x.why}`}</li>
          ))}</ul>
          {tried.rows.some((x) => x.outcome !== "done") && <p>The rows skipped are still ticked.</p>}
          {refused && !refused.ok && <ActionOutcome state={refused} />}
          <p className="row-actions">
            {tried.left.length > 0 && <Button variant={s.variant} busy={pending} onClick={more}>{pending ? s.busyLabel : `Do the next ${Math.min(tried.left.length, s.cap)}`}</Button>}
            <Button variant="secondary" onClick={() => { if (!pending) { setRefused(null); onClose(); } }}>Done</Button>
          </p>
        </div>
      )}
    </Sheet>
  );
}

/**
 * One bulk action in BulkSelect's bar (`actions`): a button naming what it does to how many ("Create 3 families"), and
 * the Drawer it opens. The Drawer says first what would happen to each row ticked (`rows`: the row's name and its line,
 * the page's own words), then, once pressed, what did, row by row: done, skipped with the reason the row's own press
 * gave, or failed (in BulkResults' Drawer, which outlives the rows). The rows skipped, failed or past the press's cap
 * stay ticked, and "Do the next N" sends the ones not tried yet. `act` is the server action, sent only the ids (and the
 * one note `reason` asks for): it checks every id again, and works each row through the single row's own press.
 */
export function BulkAction({ rows, label, confirmLabel, busyLabel = "Working…", description, done, reason, variant = "primary", cap = 200, act }: {
  /** Each row a press can take, by its id: its name, and what the press would do to it, in the page's words. */
  rows: ReadonlyMap<string, { name: string; line: string }>;
  /** The bar's button and the Drawer's title, for this many rows: a verb and its object. */
  label: (n: number) => string;
  /** The press inside the Drawer: a verb and its object. */
  confirmLabel: (n: number) => string;
  busyLabel?: string;
  /** One sentence: what follows, before pressing. */
  description: string;
  /** The word for a row done ("Linked"). */
  done: string;
  reason?: { label: string; maxLength: number };
  variant?: ButtonVariant;
  /** At most this many rows are tried in one press (src/lib/bulk.ts's PRESS_MAX). */
  cap?: number;
  act: ((ids: string[]) => Promise<BulkAnswer>) | ((ids: string[], note: string) => Promise<BulkAnswer>);
}) {
  const b = useBulkSelection();
  const page = useContext(Results);
  const [local, setLocal] = useState<Shown | null>(null);
  const show = page ?? setLocal;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  const [refused, setRefused] = useState<BulkAnswer | null>(null);
  const [titleN, setTitleN] = useState(0);
  const noteId = useId();
  // Only the rows this action can take: a box ticked on a row it doesn't know (one gone since) is left out.
  const isTicked = (id: string) => (b.selection.allMatching ? !b.selection.except.has(id) : b.selection.ids.has(id));
  const chosen = b.pageIds.filter((id) => rows.has(id) && isTicked(id));
  const n = chosen.length;
  const names = new Map([...rows].map(([id, r]) => [id, r.name]));
  // Sends ids, then unticks the rows done: every other stays ticked, those skipped and those not tried yet among them.
  const call = async (ids: string[], text: string): Promise<BulkAnswer> => {
    const r = await safely(() => (reason ? (act as (i: string[], t: string) => Promise<BulkAnswer>)(ids, text) : (act as (i: string[]) => Promise<BulkAnswer>)(ids)),
      { ok: false as const, errors: [ACTION_FAILED] });
    if (r.ok) b.untick(r.rows.filter((x) => x.outcome === "done").map((x) => x.id));
    return r;
  };
  const send = () => {
    if (pending || n === 0) return;
    setPending(true);
    setRefused(null);
    const text = note;
    startTransition(async () => {
      const r = await call(chosen, text);
      setPending(false);
      if (!r.ok) { setRefused(r); return; }
      setOpen(false);
      setNote("");
      show({ title: label(titleN), answer: r, names, done, variant, busyLabel, cap, next: (ids) => call(ids, text) });
    });
  };
  const close = () => { if (!pending) { setOpen(false); setRefused(null); } };
  return (
    <>
      <Button variant={variant === "danger" ? "danger" : "secondary"} size="sm" onClick={() => { setRefused(null); setTitleN(n); setOpen(true); }} aria-disabled={n === 0 || undefined}>{label(n)}</Button>
      <Sheet open={open} onClose={close} title={label(titleN)} description={description}>
        <div className="stack">
          {n === 0 ? <Notice tone="info" live="none">None of the rows ticked can be taken by this. Tick the rows it offers a box for.</Notice> : (
            <>
              {n > cap && <Notice tone="info" live="none">Up to {cap} are done at a time: these first {cap} now, then the next {n - cap}.</Notice>}
              <ul>{chosen.slice(0, cap).map((id) => <li key={id}>{rows.get(id)!.line}</li>)}</ul>
              {reason && <TextArea id={noteId} label={reason.label} rows={2} maxLength={reason.maxLength} value={note} onChange={(e) => setNote(e.target.value)} />}
              {refused && !refused.ok && <ActionOutcome state={refused} />}
              <p className="row-actions">
                <Button variant={variant} busy={pending} onClick={send}>{pending ? busyLabel : confirmLabel(Math.min(n, cap))}</Button>
                <Button variant="secondary" onClick={close}>Cancel</Button>
              </p>
            </>
          )}
        </div>
      </Sheet>
      {page === null && <ResultsSheet shown={local} onClose={() => setLocal(null)} onNext={setLocal} />}
    </>
  );
}
