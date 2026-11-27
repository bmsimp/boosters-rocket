"use client";
import { ActionOutcome } from "@/app/components/notice";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

// A single button with nothing to type may use a form action.
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/** One button for one switch. Nothing is typed, so a plain form action is fine. */
export function SwitchButton({ label, pendingLabel, quiet, act }: { label: string; pendingLabel: string; quiet?: boolean; act: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form action={run} className="stack">
      <Outcome state={state} />
      <button className={quiet ? "btn btn-outlined" : "btn"} disabled={pending}>{pending ? pendingLabel : label}</button>
    </form>
  );
}
