"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionOutcome, Button } from "@/app/components/ui";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { versionAgainAction } from "../actions";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };

/** "Use these words again": the earlier version shown saved as the email's next, then back to the current words. */
export function UseVersionAgain({ emailKey, n }: { emailKey: string; n: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<Done | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <Button variant="tonal" busy={pending} onClick={() => start(async () => {
        const r = await safely(() => versionAgainAction(emailKey, n), { ok: false as const, errors: [ACTION_FAILED] });
        if (r.ok) router.push(`/staff/settings/emails/${emailKey}`);
        else { setOutcome(r); requestAnimationFrame(() => ref.current?.focus()); }
      })}>Use these words again</Button>
      {outcome && <ActionOutcome state={outcome} ref={ref} />}
    </>
  );
}
