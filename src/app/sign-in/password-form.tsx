"use client";
import { useActionState, useEffect, useRef } from "react";
import { safely } from "@/app/components/action-error";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import type { LinkPurpose } from "@/lib/parents/signin-links";
import { choosePasswordAction } from "./password-actions";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };

const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

/**
 * The form of a set-up or reset link. It is given the token, which is in the page's address already and is what it
 * sends back, and the link's purpose, and nothing else: no name, no address, no username for a password manager. The
 * password is typed twice; the rule is said in words. Once it is set, the page says so and points to sign in, and
 * nothing more happens here.
 */
export function PasswordForm({ token, purpose }: { token: string; purpose: LinkPurpose }) {
  const [result, action, pending] = useActionState(async (_prev: Result | null, f: FormData): Promise<Result> =>
    safely(() => choosePasswordAction(purpose, token, f.get("password"), f.get("again")), { ok: false as const, errors: [PASSWORD_COPY.failed] }), null);
  if (result?.ok) return <PasswordSet message={result.message} />;
  return (
    <form action={action} className="stack" onSubmit={(e) => { if (pending) e.preventDefault(); }}>
      <p className="help" id="password-rule">{PASSWORD_COPY.rule}</p>
      <label className="field">
        <span>{purpose === "reset" ? "New password" : "Password"}</span>
        <input name="password" type="password" autoComplete="new-password" required aria-describedby="password-rule" />
      </label>
      <label className="field">
        <span>Type it again</span>
        <input name="again" type="password" autoComplete="new-password" required />
      </label>
      {result && !result.ok && <ul role="alert" className="errors">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
      <button className="btn" aria-disabled={pending || undefined}>{pending ? "Saving…" : "Save my password"}</button>
    </form>
  );
}

/** The password is set: the words take the focus the button had, which is gone with its form. */
function PasswordSet({ message }: { message: string }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => { line.current?.focus(); }, []);
  return (
    <>
      <p ref={line} role="status" tabIndex={-1} className="paid-up"><Tick />{message}</p>
      <p><a className="link-line" href="/sign-in">Go to sign in</a></p>
    </>
  );
}
