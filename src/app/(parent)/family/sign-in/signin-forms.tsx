"use client";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { safely } from "@/app/components/action-error";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { askAgainCodeAction, askAgainPasswordAction, askSetupLinkAction, changePasswordAction, signOutEverywhereAction } from "./actions";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const FAILED: Result = { ok: false, errors: [COPY.failed] };

const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;
const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

/**
 * The address the parent signs in with, for a password manager: it tells which account the password fields are for.
 * It is the address the page already shows, and the form sends nothing of it (the actions read the session's own).
 */
const Username = ({ email }: { email: string }) => <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />;

/** Words that take the focus once they are drawn: the answer to a press whose form has gone. */
function Said({ message, children }: { message: string; children?: ReactNode }) {
  const line = useRef<HTMLParagraphElement>(null);
  useEffect(() => { line.current?.focus(); }, []);
  return (
    <>
      <p ref={line} role="status" tabIndex={-1} className="paid-up"><Tick />{message}</p>
      {children}
    </>
  );
}

/** Where a signed-out parent goes to sign in again, and its words; none when only the club can help. */
export type SignInAgain = { href: string; label: string } | null;
/** What a press that signed the parent out everywhere answers: what happened, what next, and the way back in. */
type Out = { message: string; next: string; signIn: SignInAgain };

/** Signed out everywhere: what happens next, and the way to sign in again. */
const SignedOut = ({ message, next, signIn }: Out) => (
  <Said message={message}>
    <p className="help">{next}</p>
    {signIn && <div className="box-foot"><a className="btn" href={signIn.href}>{signIn.label}</a></div>}
  </Said>
);

/** The page's frame's way to hear that a press signed the parent out (SignInSettingsFrame). */
const SignedOutContext = createContext<((out: Out) => void) | null>(null);

/**
 * The sign-in settings page's forms, as one: once a press has signed the parent out everywhere (the password changed,
 * or "Sign out everywhere"), every other form of the page would only be refused, since the session is gone, so the
 * frame draws the answer alone, in place of them all. Given nothing but the page's own children.
 */
export function SignInSettingsFrame({ children }: { children: ReactNode }) {
  const [out, setOut] = useState<Out | null>(null);
  if (out) return <section className="box"><SignedOut {...out} /></section>;
  return <SignedOutContext.Provider value={setOut}>{children}</SignedOutContext.Provider>;
}

/**
 * Asking again (src/lib/parents/asking-again.ts): before a change of how the parent signs in, a session that hasn't
 * proved itself in the last 10 minutes is asked for the password, then for the code it emails. `proved` is what the
 * page read for this session; `children` is the change itself, drawn once proved. Given only what it shows: the address
 * (for a password manager's username field) and the words of its lede. Between the two steps it keeps the stamp the
 * server answered with, which names nothing, and sends it back with the code.
 */
export function AskAgain({ email, proved, lede, children }: { email: string; proved: boolean; lede: string; children: ReactNode }) {
  const [step, setStep] = useState<"password" | "code" | "proved" | "arrived">(proved ? "proved" : "password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stamp, setStamp] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[] | null>(null);
  // Moving between the steps draws the other form, so its field takes the focus (not on first drawing).
  const field = useRef<HTMLInputElement>(null);
  const moved = useRef(false);
  // The code field is described by the words that say a code was emailed: a live region drawn with its words already
  // in it is seldom read out, so the field that takes the focus carries them.
  const sentId = useId();
  useEffect(() => { if (moved.current) field.current?.focus(); }, [step]);

  if (step === "proved") return <>{children}</>;
  if (step === "arrived") return <Said message={COPY.proved}>{children}</Said>;

  const checkPassword = async () => {
    setBusy(true); setErrors(null);
    const r = await safely(() => askAgainPasswordAction(password), { ok: false as const, errors: [COPY.failed] });
    setBusy(false);
    if (!r.ok) { setErrors(r.errors); return; }
    moved.current = true; setStamp(r.stamp); setPassword(""); setCode(""); setStep("code");
  };
  const checkCode = async () => {
    setBusy(true); setErrors(null);
    const r = await safely(() => askAgainCodeAction(stamp, code), FAILED);
    setBusy(false);
    if (!r.ok) { setErrors(r.errors); return; }
    setStamp(""); setCode(""); setStep("arrived");
  };
  // Starting again keeps nothing of the step it leaves.
  const startAgain = () => { moved.current = true; setStamp(""); setCode(""); setPassword(""); setErrors(null); setStep("password"); };

  if (step === "password") {
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void checkPassword(); }}>
        <p>{lede}</p>
        <Username email={email} />
        <label className="field"><span>{COPY.yourPassword}</span>
          <input ref={field} name="password" type="password" required autoComplete="current-password" maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {errors && <Errors errors={errors} />}
        {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
        <button className="btn" aria-disabled={busy || undefined}>{busy ? COPY.checking : COPY.continue}</button>
      </form>
    );
  }
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void checkCode(); }}>
      <p role="status" id={sentId}>{COPY.codeSent}</p>
      <label className="field"><span>{COPY.code}</span>
        <input ref={field} name="code" aria-describedby={sentId} inputMode="numeric" autoComplete="one-time-code" maxLength={9} required value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {errors && <Errors errors={errors} />}
      <button className="btn" aria-disabled={busy || undefined}>{busy ? COPY.checking : COPY.confirm}</button>
      <button type="button" className="btn btn-line" onClick={startAgain}>{COPY.startAgain}</button>
    </form>
  );
}

/**
 * The new password, twice. Shown only once the session has proved itself: the current password is not asked again. A
 * change that was made signs the parent out everywhere, this device too, so the answer brings the way to sign in again.
 */
export function ChangePasswordForm({ email }: { email: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const signedOut = useContext(SignedOutContext);
  if (result?.ok) return <SignedOut message={result.message} next={COPY.changedNext} signIn={{ href: "/sign-in", label: COPY.signIn }} />;
  const change = async () => {
    setBusy(true); setResult(null);
    const r = await safely(() => changePasswordAction(password, again), FAILED);
    setBusy(false);
    if (r.ok && signedOut) { signedOut({ message: r.message, next: COPY.changedNext, signIn: { href: "/sign-in", label: COPY.signIn } }); return; }
    setResult(r);
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void change(); }}>
      <Username email={email} />
      <p className="help" id="new-password-rule">{PASSWORD_COPY.rule}</p>
      <label className="field"><span>{COPY.newPassword}</span>
        <input name="new-password" type="password" required autoComplete="new-password" maxLength={1024} aria-describedby="new-password-rule"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="field"><span>{COPY.newPasswordAgain}</span>
        <input name="new-password-again" type="password" required autoComplete="new-password" maxLength={1024} value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      <p>{COPY.signsOutEverywhere}</p>
      {result && !result.ok && <Errors errors={result.errors} />}
      <button className="btn" aria-disabled={busy || undefined}>{busy ? COPY.changeBusy : COPY.changeButton}</button>
    </form>
  );
}

/**
 * "Sign out everywhere": the words before it say what it does, the answer what happens next. Given only the words the
 * page chose for this parent (with a password, with none yet, or with none under Strict) and where they sign in again.
 */
export function SignOutEverywhereForm({ then, next, signIn }: { then: string; next: string; signIn: SignInAgain }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const signedOut = useContext(SignedOutContext);
  if (result?.ok) return <SignedOut message={result.message} next={next} signIn={signIn} />;
  const press = async () => {
    setBusy(true); setResult(null);
    const r = await safely(() => signOutEverywhereAction(), FAILED);
    setBusy(false);
    if (r.ok && signedOut) { signedOut({ message: r.message, next, signIn }); return; }
    setResult(r);
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void press(); }}>
      <p>{COPY.everywhereLede}</p>
      <p>{then}</p>
      {result && !result.ok && <Errors errors={result.errors} />}
      <button className="btn btn-line" aria-disabled={busy || undefined}>{busy ? COPY.everywhereBusy : COPY.everywhereButton}</button>
    </form>
  );
}

/** The offer to a person with no password: a link to choose one, emailed to the address they sign in with. Given nothing. */
export function SetupLinkForm() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const press = async () => {
    setBusy(true); setResult(null);
    const r = await safely(() => askSetupLinkAction(), FAILED);
    setBusy(false);
    setResult(r);
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void press(); }}>
      {result && !result.ok && <Errors errors={result.errors} />}
      {result?.ok && <p role="status" className="paid-up"><Tick />{result.message}</p>}
      <button className="btn" aria-disabled={busy || undefined}>{busy ? COPY.setupBusy : COPY.setupButton}</button>
    </form>
  );
}
