"use client";
import { useEffect, useRef, useState } from "react";
import { APP_ASKED, APP_CODE_LABEL, APP_REJECTED, APP_STEP_ENDED, APP_STEP_OVER, CODE_SENT, CODE_REJECTED, CODE_STEP_ENDED, PASSWORD_REJECTED, SIGNIN_LEDE, TOO_MANY_TRIES, signinFailure } from "@/lib/parents/signin-copy";
import { CODE_STEP_LIFE_MS, clearCodeStep, deviceStore, loadCodeStep, saveCodeStep, type CodeStepKind } from "./code-step";

const BASE = "/api/auth/parent";
const RESEND_SECONDS = 60;

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!r.ok) throw new HttpStatus(r.status);
  return (await r.json()) as T;
}
class HttpStatus extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
const failure = (e: unknown) => signinFailure(e instanceof HttpStatus ? e.status : null);

type Answer = { ok: boolean; next?: string; step?: "code" | "app"; error?: string; ended?: boolean };
/** What went wrong, in words, with whether to show the way to set up or reset a password beside it. */
type Problem = { words: string; passwordLink: boolean };

/**
 * Spec §1 The pages, as the sign-in release's slice SI-3b made them: the email and the password on one form, then, on a
 * device the portal doesn't remember, the 6-digit code it emails, or, since slice SI-6a, for a parent with an
 * authenticator app, the app's code or a backup code (the app step: nothing is emailed, so there is no Resend). The page
 * never says whether the address is on file.
 * The step between the two is the server's (a signed cookie this component never sets or reads); the device keeps only
 * when the second step was asked for, which one it is, and where to go (./code-step.ts). `next` is the page the parent asked for, already checked
 * by the sign-in page; the portal checks it again when the sign-in finishes.
 */
export function PasswordSignIn({ next }: { next: string | null }) {
  const [step, setStep] = useState<"password" | CodeStepKind>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // When the step began (the right password: the server's pending step ends CODE_STEP_LIFE_MS after it, however late a
  // code is resent), and when its newest code was asked for (for Resend's one-a-minute wait).
  const [startedAt, setStartedAt] = useState(0);
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(0);
  const [back, setBack] = useState(next);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Moving between the steps draws the other form, so the first field of the new step takes the focus (not on first drawing).
  const field = useRef<HTMLInputElement>(null);
  const moved = useRef(false);
  useEffect(() => { if (moved.current) field.current?.focus(); }, [step]);

  // A reload in the middle (a phone reloads an installed app when the parent comes back from their mail) picks the
  // code step up where it was. What the device kept is unknowable on the server, so it is read after mount.
  useEffect(() => {
    const saved = loadCodeStep(deviceStore(), Date.now());
    if (!saved) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setStartedAt(saved.sentAt); setSentAt(saved.sentAt); setNow(Date.now()); setStep(saved.kind);
    if (!next) setBack(saved.next);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [next]);

  // Once the step's time is over no code can work, so the page goes back to the password step and says so.
  useEffect(() => {
    if (step === "password") return;
    const t = setInterval(() => {
      const at = Date.now();
      if (at - startedAt < CODE_STEP_LIFE_MS) { setNow(at); return; }
      clearCodeStep(deviceStore()); moved.current = true;
      setStep("password"); setEmail(""); setPassword(""); setBack(next); setCode("");
      setProblem({ words: step === "app" ? APP_STEP_ENDED : CODE_STEP_ENDED, passwordLink: false });
    }, 1000);
    return () => clearInterval(t);
  }, [step, startedAt, next]);

  const toCodeStep = (kind: CodeStepKind) => {
    const t = Date.now();
    saveCodeStep(deviceStore(), { sentAt: t, next: back, kind });
    moved.current = true; setStartedAt(t); setSentAt(t); setNow(t); setCode(""); setPassword(""); setStep(kind);
  };
  const signIn = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await post<Answer>("/portal-password/check", { email, password, ...(back ? { next: back } : {}) });
      if (r.ok && r.next) { clearCodeStep(deviceStore()); window.location.assign(r.next); return; }
      if (r.ok && (r.step === "code" || r.step === "app")) { toCodeStep(r.step); return; }
      // Too many tries is said as such, with no way to a reset: a reset ends every session and doesn't shorten the wait.
      setProblem(r.error === "rate_limited" ? { words: TOO_MANY_TRIES, passwordLink: false } : { words: PASSWORD_REJECTED, passwordLink: true });
    } catch (e) { setProblem({ words: failure(e), passwordLink: false }); } finally { setBusy(false); }
  };
  const resend = async () => {
    setBusy(true); setProblem(null);
    try {
      await post<{ ok: true }>("/portal-code/resend", {});
      // The stored step keeps its first time: a resent code ends when the step does, so a reload never outlives it.
      const t = Date.now();
      setSentAt(t); setNow(t); setCode("");
      // Resend is now waiting (disabled), so its focus goes to the field.
      field.current?.focus();
    } catch (e) { setProblem({ words: failure(e), passwordLink: false }); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await post<Answer>(step === "app" ? "/portal-app/check" : "/portal-code/check", { code, ...(back ? { next: back } : {}) });
      if (r.ok && r.next) { clearCodeStep(deviceStore()); window.location.assign(r.next); return; }
      if (step === "app" && r.ended) {
        // The server ended the step (it never says why): back to the password step, as when its time runs out.
        clearCodeStep(deviceStore()); moved.current = true;
        setStep("password"); setEmail(""); setPassword(""); setBack(next); setCode("");
        setProblem({ words: `${APP_REJECTED} ${APP_STEP_OVER}`, passwordLink: false });
        return;
      }
      setProblem({ words: r.error === "rate_limited" ? TOO_MANY_TRIES : step === "app" ? APP_REJECTED : CODE_REJECTED, passwordLink: false });
    } catch (e) { setProblem({ words: failure(e), passwordLink: false }); } finally { setBusy(false); }
  };
  // Starting again keeps nothing of the step it leaves, which on a shared device may have been somebody else's: not the
  // address, not the password, and not the page they were heading to. Only what this page load itself was asked for stays.
  const startAgain = () => {
    clearCodeStep(deviceStore()); moved.current = true;
    setStep("password"); setEmail(""); setPassword(""); setBack(next); setCode(""); setProblem(null);
  };
  const wait = Math.max(0, RESEND_SECONDS - Math.floor((now - sentAt) / 1000));
  // In the step's last minute the server sends no new code (it would be dead before it was read), so none is offered.
  const lastMinute = CODE_STEP_LIFE_MS - (now - startedAt) < RESEND_SECONDS * 1000;
  const shown = problem && (
    <div role="alert">
      <p className="errors">{problem.words}</p>
      {problem.passwordLink && <p><a className="link-line" href="/sign-in/password">Set up or reset my password</a></p>}
    </div>
  );

  if (step === "password") {
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void signIn(); }}>
        <p className="lede">{SIGNIN_LEDE}</p>
        <label className="field"><span>Email</span>
          <input ref={field} name="email" type="email" required autoComplete="username" maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field"><span>Password</span>
          <input name="password" type="password" required autoComplete="current-password" maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {shown}
        {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
        <button className="btn" aria-disabled={busy || undefined}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    );
  }
  if (step === "app") {
    // One field for the app's 6-digit code or a backup code, so its keyboard is a text one. No Resend: nothing is emailed.
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void check(); }}>
        <p role="status" id="app-step-words">{APP_ASKED}</p>
        <label className="field"><span>{APP_CODE_LABEL}</span>
          <input ref={field} name="code" aria-describedby="app-step-words" inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            autoComplete="one-time-code" maxLength={20} required value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        {shown}
        <button className="btn" aria-disabled={busy || undefined}>{busy ? "Checking…" : "Confirm"}</button>
        <button type="button" className="btn btn-line" onClick={startAgain}>Start again</button>
      </form>
    );
  }
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void check(); }}>
      <p role="status">{CODE_SENT}</p>
      <label className="field"><span>6-digit code</span>
        <input ref={field} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={9} required value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {shown}
      <button className="btn" aria-disabled={busy || undefined}>{busy ? "Checking…" : "Sign in"}</button>
      <div className="stack">
        <button type="button" className="btn btn-line" disabled={busy || wait > 0 || lastMinute} onClick={() => void resend()}>
          {wait > 0 ? `Resend code (${wait} s)` : "Resend code"}
        </button>
        <button type="button" className="btn btn-line" onClick={startAgain}>Start again</button>
      </div>
    </form>
  );
}
