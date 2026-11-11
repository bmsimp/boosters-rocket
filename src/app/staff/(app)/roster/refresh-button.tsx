"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

type Result = { ok: true; message: string } | { ok: false; error: string };

export function RefreshButton({ refresh }: { refresh: () => Promise<Result> }) {
  const [state, run, pending] = useActionState(async () => safely(() => refresh(), { ok: false as const, error: ACTION_FAILED }), null);
  return (
    <form action={run} className="stack">
      {state && !state.ok && <p role="alert" className="errors">{state.error}</p>}
      {state?.ok && <p role="status">{state.message}</p>}
      <button className="btn btn-line" disabled={pending}>{pending ? "Reading QuickBooks…" : "Refresh now"}</button>
    </form>
  );
}
