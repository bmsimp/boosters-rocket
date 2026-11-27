"use client";
import { ActionOutcome } from "@/app/components/notice";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { Done } from "./forms";

const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

/**
 * A volunteer requirement's buy-out: the price per shift or hour still owed, typed in dollars and cents, and the
 * QuickBooks product or service it is billed with. Given only what it shows: the price as text, each item's id (the
 * value sent back) and name. "Switch it off" stops new choices; buy-outs already chosen stay as they are.
 */
export function BuyoutForm({ per, price, chosen, items, offered, save }: {
  per: string; price: string; chosen: string | null; items: { qboId: string; label: string }[]; offered: boolean;
  save: (price: string | null, itemQboId: string | null) => Promise<Done>;
}) {
  const [text, setText] = useState(price);
  const [item, setItem] = useState(chosen ?? "");
  const [state, run, pending] = useActionState(async (_: Done | null, off: boolean) => safely(() => save(off ? null : text.trim(), off || item === "" ? null : item), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Price {per}, in dollars and cents</span>
        <input inputMode="decimal" maxLength={20} value={text} onChange={(e) => setText(e.target.value)} placeholder="25.00" /></label>
      <label className="field"><span>Billed with this product or service in QuickBooks</span>
        <select value={item} onChange={(e) => setItem(e.target.value)}>
          <option value="">Choose one</option>
          {items.map((i) => <option key={i.qboId} value={i.qboId}>{i.label}</option>)}
        </select></label>
      <ActionOutcome state={state} />
      <div className="row-actions">
        <button type="button" className="btn btn-outlined" disabled={pending} onClick={() => startTransition(() => run(false))}>{pending ? "Saving…" : offered ? "Save the buy-out" : "Offer a buy-out"}</button>
        {offered && <button type="button" className="btn btn-outlined" disabled={pending} onClick={() => startTransition(() => run(true))}>Switch it off</button>}
      </div>
    </form>
  );
}
