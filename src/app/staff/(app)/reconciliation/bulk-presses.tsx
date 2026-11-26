"use client";
import { BulkAction, type BulkAnswer } from "@/app/components/ui/bulk-action";
import { PRESS_MAX } from "@/lib/bulk";

// Reconciliation's bulk presses (src/lib/bulk.ts), in each list's BulkSelect bar: Try again on many stuck or waiting
// changes, and Give up on many, with one note for them all. Each is given only what its Drawer shows (each change's
// words, and for Try again what happens to it) and the ids, with the server action.

/** A change a press can take: its id, its words (as the row says it), and what Try again does to it. */
export type QueuePick = { id: string; words: string; again: string };

export function TryAgainBulk({ rows, act }: { rows: QueuePick[]; act: (ids: string[]) => Promise<BulkAnswer> }) {
  const shown = new Map(rows.map((r) => [r.id, { name: r.words, line: `${r.words}: ${r.again}` }]));
  return (
    <BulkAction rows={shown} cap={PRESS_MAX}
      label={(n) => (n === 1 ? "Try 1 change again" : `Try ${n} changes again`)}
      confirmLabel={(n) => (n === 1 ? "Try 1 change again" : `Try ${n} changes again`)} busyLabel="Asking…" done="Tried again within a minute"
      description="Each is tried again at the worker's next wake, within a minute." act={act} />
  );
}

export function GiveUpBulk({ rows, act }: { rows: QueuePick[]; act: (ids: string[], note: string) => Promise<BulkAnswer> }) {
  const shown = new Map(rows.map((r) => [r.id, { name: r.words, line: r.words }]));
  return (
    <BulkAction rows={shown} cap={PRESS_MAX} variant="danger"
      label={(n) => (n === 1 ? "Give up on 1 change" : `Give up on ${n} changes`)}
      confirmLabel={(n) => (n === 1 ? "Give up on 1 change" : `Give up on ${n} changes`)} busyLabel="Giving up…" done="Given up"
      description="The portal keeps its own value, and QuickBooks keeps what it has."
      reason={{ label: "Why? One note for them all (kept in the audit log)", maxLength: 500 }} act={act} />
  );
}
