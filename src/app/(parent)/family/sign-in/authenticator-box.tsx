"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { confirmAuthenticatorAction, newBackupCodesAction, startAuthenticatorAction, turnOffAuthenticatorAction } from "./actions";
import { AskAgain } from "./signin-forms";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const FAILED = { ok: false as const, errors: [COPY.failed] };
const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;
const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

/** A press that copies `text`, and only it, saying in words whether it did. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState("copied"); } catch { setState("failed"); }
  };
  return (
    <div className="stack">
      <button type="button" className="btn btn-line" onClick={() => void copy()}>{label}</button>
      <p role="status" className="help">{state === "copied" ? COPY.copied : state === "failed" ? COPY.copyFailed : ""}</p>
    </div>
  );
}

/** The parent's app as the page shows it (MyApp, src/lib/parents/signin-settings.ts): when it was set up, and the backup codes left. */
export type ShownApp = { since: string; backupCodesLeft: number };
/** The set-up's first answer, kept only in this component's state: the key to type and the QR code's squares. */
type Setup = { key: string; qr: { size: number; path: string } };
type SetupResult = ({ ok: true; message: string } & Setup) | { ok: false; errors: string[] };
type CodesResult = { ok: true; message: string; codes: string[] } | { ok: false; errors: string[]; setupOver?: true };
type Busy = "start" | "confirm" | "codes" | "off" | null;

/**
 * The authenticator app on the sign-in settings page (slice SI-6b; src/lib/parents/authenticator-settings.ts). Off: what
 * an app is, and, asked again first (AskAgain) unless the session proved itself in the last 10 minutes, "Set up an
 * authenticator app" (not for a parent with no password, who is told to choose one first, and not under Strict). Being
 * set up, in this component's state alone: the QR code drawn from the squares the press answered, the key to type with
 * its copy press, and the code field; a reload or leaving the page loses them, and the next press makes a new key. On:
 * since when, the backup codes left, and, asked again, new backup codes and turning it off (under Strict, words in
 * place of turning off). Backup codes are shown once, as they are made, from the press's answer, in this component's
 * state: the page drawn again never holds them. Given only what it shows: the address for AskAgain's username field,
 * whether a password is chosen, whether the session proved itself, whether the club is at Strict, and the app's two
 * facts.
 */
export function AuthenticatorBox({ email, app, proved, hasPassword, strict }: { email: string; app: ShownApp | null; proved: boolean; hasPassword: boolean; strict: boolean }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<{ message: string; list: string[] } | null>(null);
  const [answer, setAnswer] = useState<Result | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  // Where the focus lands after a press that draws something new: the words at the top of what it drew.
  const landing = useRef<HTMLParagraphElement>(null);
  const answerLine = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState(0);
  useEffect(() => { if (landed) landing.current?.focus(); }, [landed]);
  // Turning off draws the box again without the app once the page is drawn again: the answer takes the focus then too.
  const appOn = app !== null;
  useEffect(() => { if (answer) answerLine.current?.focus(); }, [answer, appOn]);

  const start = async () => {
    if (busy) return;
    setBusy("start"); setAnswer(null);
    const r: SetupResult = await safely(() => startAuthenticatorAction(), FAILED);
    setBusy(null);
    if (!r.ok) { setAnswer(r); return; }
    setCode(""); setSetup({ key: r.key, qr: r.qr }); setLanded((n) => n + 1);
  };
  const confirm = async () => {
    if (busy) return;
    setBusy("confirm"); setAnswer(null);
    const r: CodesResult = await safely(() => confirmAuthenticatorAction(code), FAILED);
    setBusy(null);
    // Nothing left to finish (run out, replaced, or finished in another window): the dead QR code and key go, and the
    // box draws its set-up press (or the app, once the page is drawn again) under the words.
    if (!r.ok) { if (r.setupOver) { setSetup(null); setCode(""); } setAnswer(r); return; }
    setSetup(null); setCode(""); setCodes({ message: r.message, list: r.codes }); setLanded((n) => n + 1);
  };
  const newCodes = async () => {
    if (busy) return;
    setBusy("codes"); setAnswer(null);
    const r: CodesResult = await safely(() => newBackupCodesAction(), FAILED);
    setBusy(null);
    if (!r.ok) { setAnswer(r); return; }
    setCodes({ message: r.message, list: r.codes }); setLanded((n) => n + 1);
  };
  const turnOff = async () => {
    if (busy) return;
    setBusy("off"); setAnswer(null);
    const r: Result = await safely(() => turnOffAuthenticatorAction(), FAILED);
    setBusy(null);
    if (r.ok) setCodes(null);
    setAnswer(r);
  };

  const answered = answer && (
    <div ref={answerLine} tabIndex={-1}>
      {answer.ok ? <p role="status" className="paid-up"><Tick />{answer.message}</p> : <Errors errors={answer.errors} />}
    </div>
  );
  const on = app && <AppOn app={app} email={email} proved={proved} strict={strict} busy={busy} answered={codes ? null : answered} newCodes={newCodes} turnOff={turnOff} />;

  // The backup codes, once, as they were made, above the app's box.
  if (codes) {
    return (
      <div className="stack">
        <p ref={landing} role="status" tabIndex={-1} className="paid-up"><Tick />{codes.message}</p>
        <h3>{COPY.backupCodesTitle}</h3>
        <p>{COPY.backupCodesKeep}</p>
        <ul className="backup-codes" aria-label={COPY.backupCodesTitle}>
          {codes.list.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
        <CopyButton text={codes.list.join("\n")} label={COPY.copyCodes} />
        {answered}
        {on}
      </div>
    );
  }
  if (on) return on;

  // Being set up: the QR code and the key, once, from the press's answer, then the code that finishes it.
  if (setup) {
    return (
      <div className="stack">
        <p ref={landing} tabIndex={-1}>{COPY.appScan}</p>
        <svg className="app-qr" viewBox={`0 0 ${setup.qr.size} ${setup.qr.size}`} role="img" aria-label={COPY.appQrLabel} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
          <rect width={setup.qr.size} height={setup.qr.size} fill="white" />
          <path d={setup.qr.path} fill="black" />
        </svg>
        <div>
          <p>{COPY.appKey}</p>
          <code className="app-key">{setup.key}</code>
        </div>
        <CopyButton text={setup.key.replace(/ /g, "")} label={COPY.copyKey} />
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
          <p id="app-confirm-lede">{COPY.appConfirmLede}</p>
          <label className="field"><span>{COPY.appConfirmCode}</span>
            <input name="code" aria-describedby="app-confirm-lede" inputMode="numeric" autoComplete="one-time-code" maxLength={20} required
              value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          {answered}
          {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
          <button className="btn" aria-disabled={busy !== null || undefined}>{busy === "confirm" ? COPY.checking : COPY.appConfirm}</button>
        </form>
        <p className="help">{COPY.appSetupLost}</p>
      </div>
    );
  }

  return (
    <div className="stack">
      {answered}
      <p>{COPY.appWhat}</p>
      <p className="help">{COPY.appKeepsDevices}</p>
      {!hasPassword ? <p>{COPY.appNeedsPassword}</p>
        : strict ? <p>{COPY.appStrictOff}</p>
        : (
          <AskAgain email={email} proved={proved} lede={COPY.askAgainForApp}>
            <button type="button" className="btn" aria-disabled={busy !== null || undefined} onClick={() => void start()}>
              {busy === "start" ? COPY.appSetUpBusy : COPY.appSetUp}
            </button>
          </AskAgain>
        )}
    </div>
  );
}

/** The app in force: since when, the backup codes left, and, asked again, new codes and turning it off (Strict: words). */
function AppOn({ app, email, proved, strict, busy, answered, newCodes, turnOff }: { app: ShownApp; email: string; proved: boolean; strict: boolean;
  busy: Busy; answered: ReactNode; newCodes: () => Promise<void>; turnOff: () => Promise<void> }) {
  return (
    <div className="stack">
      <p className="paid-up"><Tick />{COPY.appOn}</p>
      <dl className="details">
        <dt>{COPY.appOnSince}</dt><dd><LocalTime iso={app.since} /></dd>
        <dt>{COPY.backupCodesLeft}</dt><dd>{app.backupCodesLeft}</dd>
      </dl>
      {app.backupCodesLeft === 0 && <p>{COPY.backupCodesNone}</p>}
      {answered}
      <AskAgain email={email} proved={proved} lede={COPY.askAgainForAppChange}>
        <div className="stack">
          <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined} onClick={() => void newCodes()}>
            {busy === "codes" ? COPY.newCodesBusy : COPY.newCodes}
          </button>
          {strict ? <p>{COPY.turnOffStrict}</p> : (
            <>
              <p>{COPY.turnOffWords}</p>
              <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined} onClick={() => void turnOff()}>
                {busy === "off" ? COPY.turnOffBusy : COPY.turnOff}
              </button>
            </>
          )}
        </div>
      </AskAgain>
    </div>
  );
}
