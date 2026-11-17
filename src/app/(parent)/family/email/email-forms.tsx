"use client";
import { useActionState, useEffect, useRef } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { confirmEmailChangeAction, requestEmailChangeAction } from "./actions";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };

const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;
const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

/**
 * The new address, to ask for the change. It is given nothing: what it sends is what the parent types. Once the link
 * is on its way, the answer says where it went and the form stays, in case the address was mistyped.
 */
export function NewEmailForm() {
  const [result, action, pending] = useActionState(async (_prev: Result | null, f: FormData): Promise<Result> =>
    safely(() => requestEmailChangeAction(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={action} className="stack" onSubmit={(e) => { if (pending) e.preventDefault(); }}>
      <label className="field">
        <span>New email</span>
        <input name="email" type="email" autoComplete="email" inputMode="email" maxLength={254} required />
      </label>
      {result && !result.ok && <Errors errors={result.errors} />}
      {result?.ok && <p role="status" className="paid-up"><Tick />{result.message}</p>}
      {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
      <button className="btn" aria-disabled={pending || undefined}>{pending ? "Sending…" : "Send me a link"}</button>
      <a className="btn btn-line" href="/family">Back to Family</a>
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
      {result && <Errors errors={result.errors} />}
      <button className="btn" aria-disabled={pending || undefined}>{pending ? "Changing…" : "Yes, use this address"}</button>
      <a className="btn btn-line" href="/family">Not now</a>
    </form>
  );
}

/** The change is made: the words take the focus the button had, which is gone with its form. */
function Changed({ message }: { message: string }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => { line.current?.focus(); }, []);
  return (
    <>
      <p ref={line} role="status" tabIndex={-1} className="paid-up"><Tick />{message}</p>
      <p className="help">You&apos;re signed out everywhere now. Sign in again with your new address.</p>
      <div className="box-foot"><a className="btn" href="/sign-in">Sign in</a></div>
    </>
  );
}
