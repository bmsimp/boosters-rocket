"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { Notice } from "@/app/components/notice";
import { Button } from "@/app/components/ui/button";

type Result = { ok: true; message: string } | { ok: false; error: string };

export function RefreshButton({ refresh }: { refresh: () => Promise<Result> }) {
  const [state, run, pending] = useActionState(async () => safely(() => refresh(), { ok: false as const, error: ACTION_FAILED }), null);
  return (
    <form action={run} className="stack">
      {state && !state.ok && <Notice tone="problem">{state.error}</Notice>}
      {state?.ok && <Notice tone="done">{state.message}</Notice>}
      <Button type="submit" variant="secondary" disabled={pending}>{pending ? "Reading QuickBooks…" : "Refresh now"}</Button>
    </form>
  );
}
