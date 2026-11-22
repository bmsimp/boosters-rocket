"use client";
import { useActionState, useEffect, useRef } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome, Button, LinkButton, Notice, TextInput } from "@/app/components/ui";
import { confirmEmailChangeAction, requestEmailChangeAction } from "./actions";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };

/**
 * The new address, to ask for the change. It is given nothing: what it sends is what the parent types. Once the link
 * is on its way, the answer says where it went and the form stays, in case the address was mistyped.
 */
export function NewEmailForm() {
  const [result, action, pending] = useActionState(async (_prev: Result | null, f: FormData): Promise<Result> =>
    safely(() => requestEmailChangeAction(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={action} className="stack" onSubmit={(e) => { if (pending) e.preventDefault(); }}>
      <TextInput id="new-email" label="New email" name="email" type="email" autoComplete="email" inputMode="email" maxLength={254} required />
      <ActionOutcome state={result} />
      {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
      <div className="row-actions">
        <Button type="submit" busy={pending}>{pending ? "Sending…" : "Send me a link"}</Button>
        <LinkButton plain variant="secondary" href="/family">Back to Family</LinkButton>
      </div>
    </form>
  );
}

/**
 * The one button on the page a link opens. It is given the token, which is in the page's address already and is what
 * it sends back. A change that was made ends the parent's sessions, so the answer brings the way to sign in again.
 */
export function ConfirmEmailForm({ token }: { token: string }) {
  const [result, action, pending] = useActionState(async (): Promise<Result> =>
    safely(() => confirmEmailChangeAction(token), { ok: false as const, errors: [ACTION_FAILED] }), null);
  if (result?.ok) return <Changed message={result.message} />;
  return (
    <form action={action} className="stack" onSubmit={(e) => { if (pending) e.preventDefault(); }}>
      <ActionOutcome state={result} />
      <div className="row-actions">
        <Button type="submit" busy={pending}>{pending ? "Changing…" : "Yes, use this address"}</Button>
        <LinkButton plain variant="secondary" href="/family">Not now</LinkButton>
      </div>
    </form>
  );
}

/** The change is made: the words take the focus the button had, which is gone with its form. */
function Changed({ message }: { message: string }) {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => { line.current?.focus(); }, []);
  return (
    <>
      <Notice tone="done" ref={line} tabIndex={-1}>{message}</Notice>
      <p className="help">You&apos;re signed out everywhere now. Sign in again with your new address.</p>
      <div className="box-foot"><LinkButton plain href="/sign-in">Sign in</LinkButton></div>
    </>
  );
}
