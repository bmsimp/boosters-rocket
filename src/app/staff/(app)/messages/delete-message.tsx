"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionOutcome } from "@/app/components/notice";
import { Button } from "@/app/components/ui";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { deleteMessageAction } from "./actions";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };

/**
 * An Admin's Delete, behind a confirm step that says what it does: families stop seeing it at once, no mail is sent,
 * its email not yet sent is dropped, and its content can't be brought back. Given only the message's id.
 */
export function DeleteMessage({ messageId }: { messageId: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<Done | null>(null);
  const [pending, start] = useTransition();
  const del = () => {
    if (pending) return;
    start(async () => {
      const r = await safely(() => deleteMessageAction(messageId), { ok: false as const, errors: [ACTION_FAILED] });
      setOutcome(r);
      if (r.ok) router.refresh();
    });
  };
  if (!asking) {
    return <div className="row-actions"><Button variant="danger" onClick={() => { setOutcome(null); setAsking(true); }}>Delete message</Button></div>;
  }
  return (
    <div className="stack">
      <p>Delete this message? Families stop seeing it at once, along with every earlier version and its files. No email is sent about it, and any of its email not yet sent is dropped. It can&apos;t be brought back.</p>
      <div className="row-actions">
        <Button variant="danger" busy={pending} onClick={del}>Yes, delete it</Button>
        <Button variant="secondary" aria-disabled={pending || undefined} onClick={() => { if (!pending) setAsking(false); }}>Keep it</Button>
      </div>
      {outcome && <ActionOutcome state={outcome} />}
    </div>
  );
}
