"use client";
import { useActionState, useEffect, useRef } from "react";
import { safely } from "@/app/components/action-error";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import type { LinkPurpose } from "@/lib/parents/signin-links";
import { choosePasswordAction } from "./password-actions";

type Result = { ok: true; message: string; next?: string } | { ok: false; errors: string[] };

const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

/**
 * What a set-up or reset link's page shows under its bar: the form, or one message that the link can't be used
 * (`usable`, the page's linkVerdict(): the same for every reason). It is given the token, which is in the page's address
 * already and is what it sends back, the link's purpose and whether it may be used, and nothing else: no name, no
 * address, no username for a password manager. The password is typed twice; the rule is said in words. Once it is
 * set, it says so and points to sign in; when the set signed the parent in (a set-up while the club's level is
 * Standard), it goes on to where the portal said (`next`), as the code form does.
 *
 * One component draws all three, so what it holds survives the page being drawn again: a sign-in sets a cookie, and
 * Next.js draws the page again with the action's answer, where the link is now spent. The words that the password is
 * set stay up while the browser moves on.
 */
export function PasswordLinkBody({ token, purpose, usable }: { token: string; purpose: LinkPurpose; usable: boolean }) {
  const [result, action, pending] = useActionState(async (_prev: Result | null, f: FormData): Promise<Result> => {
    const r = await safely(() => choosePasswordAction(purpose, token, f.get("password"), f.get("again")), { ok: false as const, errors: [PASSWORD_COPY.failed] });
    if (r.ok && r.next) window.location.assign(r.next);
    return r;
  }, null);
  const title = purpose === "reset" ? PASSWORD_COPY.resetTitle : PASSWORD_COPY.setupTitle;
  if (result?.ok) return <><h1 className="page-title">{title}</h1><PasswordSet message={result.message} next={result.next ?? null} /></>;
  if (!usable) {
    return (
      <>
        <h1 className="page-title">{PASSWORD_COPY.linkNoGoodTitle}</h1>
        <p role="status">{PASSWORD_COPY.linkNoGood}</p>
        <p><a className="link-line" href="/sign-in">Go to sign in</a></p>
      </>
    );
  }
  return (
    <>
      <h1 className="page-title">{title}</h1>
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
    </>
  );
}

/** The password is set: the words take the focus the button had, which is gone with its form. */
function PasswordSet({ message, next }: { message: string; next: string | null }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => { line.current?.focus(); }, []);
  return (
    <>
      <p ref={line} role="status" tabIndex={-1} className="paid-up"><Tick />{message}</p>
      <p>{next ? <a className="link-line" href={next}>{PASSWORD_COPY.continueIn}</a> : <a className="link-line" href="/sign-in">Go to sign in</a>}</p>
    </>
  );
}
