"use client";
import { useActionState, useEffect, useRef } from "react";
import { safely } from "@/app/components/action-error";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { askPasswordLinkAction } from "./password-actions";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };

/**
 * The form of "Set up or reset my password" (./password/page.tsx): one email field and a button. It is given whether
 * the club is at Strict, and nothing else. After any ask it shows the one answer, the same whatever the address and
 * whatever happened; an action that couldn't be reached says to try again. Under Strict it says, before and after, that
 * a guardian who can't sign in asks the club.
 */
export function PasswordRequestForm({ strict }: { strict: boolean }) {
  const [result, action, pending] = useActionState(async (_prev: Result | null, f: FormData): Promise<Result> =>
    safely<Result>(() => askPasswordLinkAction(f.get("email")), { ok: false as const, errors: [PASSWORD_COPY.failed] }), null);
  const note = strict ? <p className="help">{PASSWORD_COPY.askStrict}</p> : null;
  if (result?.ok) return <><Asked message={result.message} />{note}</>;
  return (
    <form action={action} className="stack" onSubmit={(e) => { if (pending) e.preventDefault(); }}>
      <p className="lede">{PASSWORD_COPY.askLede}</p>
      {note}
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" inputMode="email" maxLength={320} required />
      </label>
      {result && !result.ok && <ul role="alert" className="errors">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
      <button className="btn" aria-disabled={pending || undefined}>{pending ? "Sending…" : PASSWORD_COPY.askButton}</button>
    </form>
  );
}

/** The one answer: it takes the focus the button had, which is gone with its form. */
function Asked({ message }: { message: string }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => { line.current?.focus(); }, []);
  return <p ref={line} role="status" tabIndex={-1}>{message}</p>;
}
