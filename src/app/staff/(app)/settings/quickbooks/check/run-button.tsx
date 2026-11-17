"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome, Notice } from "@/app/components/notice";

/** `attention`: a request didn't answer as expected, a change wasn't tried, or the check stopped: not a "Done". */
type Result = { ok: true; message: string; attention?: true } | { ok: false; errors: string[] };

/** The one button that runs the whole check. It is given the action and nothing else. */
export function RunCheckButton({ run }: { run: () => Promise<Result> }) {
  const [state, act, pending] = useActionState(async () => safely(() => run(), { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={act} className="stack">
      {state?.ok && state.attention ? <Notice tone="warning">{state.message}</Notice> : <ActionOutcome state={state} />}
      <p><button className="btn" disabled={pending}>{pending ? "Checking with QuickBooks… this takes a minute or two" : "Run the check"}</button></p>
    </form>
  );
}
