"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";
import type { Done } from "./forms";

const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/**
 * The QuickBooks product or service a payment requirement is met by, chosen from the list last read from QuickBooks.
 * Given only what it shows: each item's id (the value sent back), its name and whether it can be chosen.
 */
export function PaymentItemForm({ items, chosen, save }: {
  items: { qboId: string; label: string }[]; chosen: string | null;
  save: (itemQboId: string | null) => Promise<Done>;
}) {
  const [value, setValue] = useState(chosen ?? "");
  const [state, run, pending] = useActionState(async () => safely(() => save(value === "" ? null : value), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Product or service in QuickBooks</span>
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">None chosen yet</option>
          {items.map((i) => <option key={i.qboId} value={i.qboId}>{i.label}</option>)}
        </select></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : "Save product or service"}</button>
    </form>
  );
}
