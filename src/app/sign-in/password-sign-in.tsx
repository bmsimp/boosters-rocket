"use client";
import { useEffect, useRef, useState } from "react";
import { APP_ASKED, APP_CODE_LABEL, APP_REJECTED, APP_STEP_ENDED, APP_STEP_OVER, CODE_SENT, CODE_REJECTED, CODE_STEP_ENDED, PASSWORD_REJECTED, SIGNIN_LEDE, TOO_MANY_TRIES, signinFailure,
  PASSKEY_ASKED, PASSKEY_BUTTON, PASSKEY_CANCELLED, PASSKEY_EXPLAINED, PASSKEY_ONLY, PASSKEY_OR_APP, PASSKEY_OR_BACKUP, BACKUP_CODE_LABEL, BACKUP_REJECTED, PASSKEY_REJECTED, PASSKEY_STEP_ENDED, PASSKEY_UNSUPPORTED, PASSKEY_USE,
  PASSKEY_STEP_CANCELLED, PASSKEY_STEP_FAILED, PASSKEY_STEP_REJECTED, PASSKEY_STEP_UNSUPPORTED, passkeyElsewhere, passkeyStepElsewhere } from "@/lib/parents/signin-copy";
import { parentAuthClient } from "@/lib/auth/client";
import { CODE_STEP_LIFE_MS, clearCodeStep, deviceStore, loadCodeStep, saveCodeStep, type CodeStepKind } from "./code-step";
import { passkeysWorkIn, readCeremony, toPortalCheck } from "./passkey-ceremony";

const BASE = "/api/auth/parent";
const RESEND_SECONDS = 60;

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!r.ok) throw new HttpStatus(r.status);
  return (await r.json()) as T;
}
class HttpStatus extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
const failure = (e: unknown) => signinFailure(e instanceof HttpStatus ? e.status : null);

type Answer = { ok: boolean; next?: string; step?: "code" | "app" | "passkey"; app?: boolean; backup?: boolean; error?: string; ended?: boolean };
/** Where passkeys can be used from this page: here, not in this browser at all, or not at this address. */
type PasskeysHere = "here" | "unsupported" | "elsewhere";
/** What went wrong, in words, with whether to show the way to set up or reset a password beside it. */
type Problem = { words: string; passwordLink: boolean };

/**
 * Spec §1 The pages, as the sign-in release's slice SI-3b made them: the email and the password on one form, then, on a
 * device the portal doesn't remember, the 6-digit code it emails, or, since slice SI-6a, for a parent with an
 * authenticator app, the app's code or a backup code (the app step: nothing is emailed, so there is no Resend), and,
 * since slice SI-7a, for a parent with a passkey, the passkey (with the app's code beside it when they have an app too,
 * and since slice SI-7b a backup code beside it when they have no app and hold unspent backup codes).
 * The first screen also offers "Sign in with a passkey" to everyone, with no address asked (open question 30): the
 * passkey library's ceremony, whose one verify request goes to the portal's own check (./passkey-ceremony.ts). The page
 * never says whether the address is on file. `portalOrigin` is APP_URL's origin, where passkeys work; reached at
 * another address, the page says so in the button's place.
 * The step between the two is the server's (a signed cookie this component never sets or reads); the device keeps only
 * when the second step was asked for, which one it is, and where to go (./code-step.ts). `next` is the page the parent asked for, already checked
 * by the sign-in page; the portal checks it again when the sign-in finishes.
 */
export function PasswordSignIn({ next, portalOrigin }: { next: string | null; portalOrigin: string }) {
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
  // At the passkey step: whether the app's code or a backup code is offered beside the passkey, or (slice SI-7b) a
  // backup code alone, for a parent with no app who holds unspent ones.
  const [appBeside, setAppBeside] = useState(false);
  const [backupBeside, setBackupBeside] = useState(false);
  // Known only in the browser, after mount: drawn as "here" first, so the server's page and the first draw agree.
  const [passkeys, setPasskeys] = useState<PasskeysHere>("here");
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setPasskeys(!passkeysWorkIn(window as unknown as Parameters<typeof passkeysWorkIn>[0]) ? "unsupported" : window.location.origin !== portalOrigin ? "elsewhere" : "here");
  }, [portalOrigin]);
  // Moving between the steps draws the other form, so the first field of the new step takes the focus (not on first drawing).
  const field = useRef<HTMLInputElement>(null);
  // The passkey step's first stop, which has no field of its own to take the focus.
  const firstButton = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => { if (moved.current) (field.current ?? firstButton.current)?.focus(); }, [step]);

  // A reload in the middle (a phone reloads an installed app when the parent comes back from their mail) picks the
  // code step up where it was. What the device kept is unknowable on the server, so it is read after mount.
  useEffect(() => {
    const saved = loadCodeStep(deviceStore(), Date.now());
    if (!saved) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setStartedAt(saved.sentAt); setSentAt(saved.sentAt); setNow(Date.now()); setStep(saved.kind); setAppBeside(saved.app === true); setBackupBeside(saved.backup === true);
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
      setProblem({ words: step === "app" ? APP_STEP_ENDED : step === "passkey" ? PASSKEY_STEP_ENDED : CODE_STEP_ENDED, passwordLink: false });
    }, 1000);
    return () => clearInterval(t);
  }, [step, startedAt, next]);

  const toCodeStep = (kind: CodeStepKind, app = false, backup = false) => {
    const t = Date.now();
    const alone = kind === "passkey" && !app && backup;
    saveCodeStep(deviceStore(), { sentAt: t, next: back, kind, ...(kind === "passkey" ? { app } : {}), ...(alone ? { backup: true } : {}) });
    moved.current = true; setStartedAt(t); setSentAt(t); setNow(t); setCode(""); setPassword(""); setAppBeside(app); setBackupBeside(alone); setStep(kind);
  };
  // A step the server ended (it never says why): back to the password step, as when its time runs out.
  const stepOver = (words: string) => {
    clearCodeStep(deviceStore()); moved.current = true;
    setStep("password"); setEmail(""); setPassword(""); setBack(next); setCode("");
    setProblem({ words: `${words} ${APP_STEP_OVER}`, passwordLink: false });
  };
  const signIn = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await post<Answer>("/portal-password/check", { email, password, ...(back ? { next: back } : {}) });
      if (r.ok && r.next) { clearCodeStep(deviceStore()); window.location.assign(r.next); return; }
      if (r.ok && r.step === "passkey") { toCodeStep("passkey", r.app === true, r.backup === true); return; }
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
    // The app's code or a backup code at the app step, or beside a passkey at the passkey step (a backup code alone
    // there for a parent with no app, slice SI-7b): the same check, /portal-app/check.
    const app = step !== "code";
    // The one answer for every refusal of the field: a backup code's own words where no app is offered.
    const rejected = step === "passkey" && !appBeside && backupBeside ? BACKUP_REJECTED : APP_REJECTED;
    try {
      const r = await post<Answer>(app ? "/portal-app/check" : "/portal-code/check", { code, ...(back ? { next: back } : {}) });
      if (r.ok && r.next) { clearCodeStep(deviceStore()); window.location.assign(r.next); return; }
      if (app && r.ended) { stepOver(rejected); return; }
      setProblem({ words: r.error === "rate_limited" ? TOO_MANY_TRIES : app ? rejected : CODE_REJECTED, passwordLink: false });
    } catch (e) { setProblem({ words: failure(e), passwordLink: false }); } finally { setBusy(false); }
  };
  // A passkey: the passkey library's ceremony (the browser's own prompt), its verify request sent to the portal's check,
  // alone from the first screen (`alone`, so a step the browser still carries from a password whose step was left is
  // cleared there and never read), and as the pending step's second step from the passkey step. The passkey step's
  // words never send the parent back to their email and password, which lead to this same step.
  const signInWithPasskey = async () => {
    setBusy(true); setProblem(null);
    const atStep = step === "passkey";
    try {
      const r = readCeremony<Answer>(await parentAuthClient.signIn.passkey({ fetchOptions: toPortalCheck(window.location.origin, back, !atStep) }));
      if (r.kind === "cancelled") { setProblem({ words: atStep ? PASSKEY_STEP_CANCELLED : PASSKEY_CANCELLED, passwordLink: false }); return; }
      if (r.kind === "failed") { setProblem({ words: signinFailure(r.status), passwordLink: false }); return; }
      if (r.body.ok && r.body.next) { clearCodeStep(deviceStore()); window.location.assign(r.body.next); return; }
      if (atStep && r.body.ended) { stepOver(PASSKEY_STEP_FAILED); return; }
      setProblem({ words: r.body.error === "rate_limited" ? TOO_MANY_TRIES : atStep ? PASSKEY_STEP_REJECTED : PASSKEY_REJECTED, passwordLink: false });
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
      <>
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
      {/* The same for every visitor: no address is asked, the browser offers the passkey (open question 30). */}
      <div className="stack">
        <p className="help" id="passkey-words">{PASSKEY_EXPLAINED}</p>
        {passkeys === "here" ? (
          <button type="button" className="btn btn-line" aria-describedby="passkey-words" aria-disabled={busy || undefined}
            onClick={() => { if (!busy) void signInWithPasskey(); }}>{PASSKEY_BUTTON}</button>
        ) : <p className="help">{passkeys === "elsewhere" ? passkeyElsewhere(portalOrigin) : PASSKEY_UNSUPPORTED}</p>}
      </div>
      </>
    );
  }
  if (step === "passkey") {
    // The passkey first; the app's code or a backup code beside it for a parent who has an app too, or a backup code
    // alone for one with no app who holds unspent ones (slice SI-7b). No Resend: nothing is emailed.
    const beside = appBeside || backupBeside;
    return (
      <div className="stack">
        <p role="status" id="passkey-step-words">{PASSKEY_ASKED} {appBeside ? PASSKEY_OR_APP : backupBeside ? PASSKEY_OR_BACKUP : PASSKEY_ONLY}</p>
        {passkeys === "here" ? (
          <button ref={firstButton} type="button" className="btn" aria-describedby="passkey-step-words" aria-disabled={busy || undefined}
            onClick={() => { if (!busy) void signInWithPasskey(); }}>{PASSKEY_USE}</button>
        ) : <p className="help">{passkeys === "elsewhere" ? passkeyStepElsewhere(portalOrigin) : PASSKEY_STEP_UNSUPPORTED}</p>}
        {beside && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void check(); }}>
            <label className="field"><span>{appBeside ? APP_CODE_LABEL : BACKUP_CODE_LABEL}</span>
              <input name="code" aria-describedby="passkey-step-words" inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                autoComplete="one-time-code" maxLength={20} required value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <button className="btn btn-line" aria-disabled={busy || undefined}>{busy ? "Checking…" : "Confirm"}</button>
          </form>
        )}
        {shown}
        <button type="button" className="btn btn-line" onClick={startAgain}>Start again</button>
      </div>
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
