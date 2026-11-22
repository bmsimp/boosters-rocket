"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { ActionOutcome, Button, KeyValue, Notice } from "@/app/components/ui";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { confirmAuthenticatorAction, newBackupCodesAction, startAuthenticatorAction, turnOffAuthenticatorAction } from "./actions";
import { AskAgain } from "./signin-forms";
import { AppSetupForm, CopyButton } from "./app-setup";
import { CodesSaved } from "./passkey-add";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const FAILED = { ok: false as const, errors: [COPY.failed] };
const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

// The copy press and the set-up's form live in app-setup.tsx since slice SI-10a, shared with Strict's enrolment.
export { CopyButton } from "./app-setup";

/** The parent's app as the page shows it (MyApp, src/lib/parents/signin-settings.ts): when it was set up, and the backup codes left. */
export type ShownApp = { since: string; backupCodesLeft: number };
/**
 * The set-up's first answer, kept only in this component's state: the key to type, the QR code's squares, and the
 * set-up's stamp, which the confirm sends back so the server can tell this set-up from a newer one or one finished elsewhere.
 */
type Setup = { key: string; qr: { size: number; path: string }; stamp: string };
type SetupResult = ({ ok: true; message: string } & Setup) | { ok: false; errors: string[] };
type CodesResult = { ok: true; message: string; codes: string[] } | { ok: false; errors: string[]; setupOver?: true };
type Busy = "start" | "confirm" | "codes" | "off" | null;

/**
 * The authenticator app on the sign-in settings page (slice SI-6b; src/lib/parents/authenticator-settings.ts). Off: what
 * an app is, and, asked again first (AskAgain) unless the session proved itself in the last 10 minutes, "Set up an
 * authenticator app" (not for a parent with no password, who is told to choose one first; at either level since slice
 * SI-10a). Being
 * set up, in this component's state alone: the QR code drawn from the squares the press answered, the key to type with
 * its copy press, and the code field; a reload or leaving the page loses them, and the next press makes a new key. On:
 * since when, the backup codes left, and, asked again, new backup codes and turning it off (under Strict, words in
 * place of turning off). Backup codes are shown once, as they are made, from the press's answer, in this component's
 * state: the page drawn again never holds them. Given only what it shows: the address for AskAgain's username field,
 * whether a password is chosen, whether the session proved itself, whether the club is at Strict, and the app's two
 * facts. Since slice SI-7b also whether they have a passkey (`passkey`), and APP_URL's origin for asking again with it:
 * beside a passkey, turning the app off keeps the backup codes and is allowed under Strict, and the words say so.
 * Since slice SI-10b, under Strict, the backup codes stay until the parent ticks that they saved them and presses Done
 * (CodesSaved), and the words of what an app is and how they sign in are Strict's.
 */
export function AuthenticatorBox({ email, app, proved, hasPassword, strict, passkey = false, portalOrigin = "" }: { email: string; app: ShownApp | null; proved: boolean;
  hasPassword: boolean; strict: boolean; passkey?: boolean; portalOrigin?: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<{ message: string; list: string[] } | null>(null);
  const [answer, setAnswer] = useState<Result | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  // Where the focus lands after a press that draws something new: the words at the top of what it drew.
  const landing = useRef<HTMLParagraphElement>(null);
  // The backup codes' line, drawn as a done notice, takes the focus the same way.
  const codesLine = useRef<HTMLDivElement>(null);
  const answerLine = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState(0);
  useEffect(() => { if (landed) (codesLine.current ?? landing.current)?.focus(); }, [landed]);
  // Turning off draws the box again without the app once the page is drawn again: the answer takes the focus then too.
  const appOn = app !== null;
  useEffect(() => { if (answer) answerLine.current?.focus(); }, [answer, appOn]);

  const start = async () => {
    if (busy) return;
    setBusy("start"); setAnswer(null);
    const r: SetupResult = await safely(() => startAuthenticatorAction(), FAILED);
    setBusy(null);
    if (!r.ok) { setAnswer(r); return; }
    setCode(""); setSetup({ key: r.key, qr: r.qr, stamp: r.stamp }); setLanded((n) => n + 1);
  };
  const confirm = async () => {
    if (busy || !setup) return;
    setBusy("confirm"); setAnswer(null);
    const r: CodesResult = await safely(() => confirmAuthenticatorAction(code, setup.stamp), FAILED);
    setBusy(null);
    // Nothing left to finish (run out, replaced by a newer set-up, or finished in another window, as the server tells by
    // the stamp): the dead QR code and key go, and the box draws its set-up press (or the app, once the page is drawn
    // again) under the words.
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

  const answered = answer && <ActionOutcome ref={answerLine} state={answer} />;
  const on = app && <AppOn app={app} email={email} proved={proved} strict={strict} busy={busy} answered={codes ? null : answered} newCodes={newCodes} turnOff={turnOff}
    passkey={passkey} portalOrigin={portalOrigin} />;

  // The backup codes, once, as they were made, above the app's box.
  if (codes) {
    return (
      <div className="stack">
        <Notice tone="done" ref={codesLine} tabIndex={-1}>{codes.message}</Notice>
        <h3>{COPY.backupCodesTitle}</h3>
        <p>{COPY.backupCodesKeep}</p>
        <ul className="backup-codes" aria-label={COPY.backupCodesTitle}>
          {codes.list.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
        <CopyButton text={codes.list.join("\n")} label={COPY.copyCodes} />
        {/* Under Strict (open question 25): put away once the parent says they saved them, the box drawn as after a press. */}
        {/* Keyed by the list: new codes pressed again while these are shown start unticked. */}
        {strict && <CodesSaved key={codes.list.join(" ")} onDone={() => { setCodes(null); setAnswer({ ok: true, message: COPY.codesPutAway }); }} />}
        {answered}
        {on}
      </div>
    );
  }
  if (on) return on;

  // Being set up: the QR code and the key, once, from the press's answer, then the code that finishes it.
  if (setup) {
    return <AppSetupForm setup={setup} code={code} onCode={setCode} onConfirm={() => void confirm()} busy={busy !== null} answered={answered}
      landing={landing} lost={COPY.appSetupLost} />;
  }

  return (
    <div className="stack">
      {answered}
      <p>{strict ? COPY.appWhatStrict : COPY.appWhat}</p>
      <p className="help">{COPY.appKeepsDevices}</p>
      {!hasPassword ? <p>{COPY.appNeedsPassword}</p>
        : (
          <AskAgain email={email} proved={proved} section={COPY.appTitle} passkey={passkey} portalOrigin={portalOrigin}>
            <Button busy={busy === "start"} aria-disabled={busy !== null || undefined} onClick={() => void start()}>
              {busy === "start" ? COPY.appSetUpBusy : COPY.appSetUp}
            </Button>
          </AskAgain>
        )}
    </div>
  );
}

/** The app in force: since when, the backup codes left, and, asked again, new codes and turning it off (Strict: words). */
function AppOn({ app, email, proved, strict, busy, answered, newCodes, turnOff, passkey, portalOrigin }: { app: ShownApp; email: string; proved: boolean; strict: boolean;
  busy: Busy; answered: ReactNode; newCodes: () => Promise<void>; turnOff: () => Promise<void>; passkey: boolean; portalOrigin: string }) {
  return (
    <div className="stack">
      <p className="paid-up"><Tick />{COPY.appOn}</p>
      <KeyValue items={[
        { key: "since", label: COPY.appOnSince, value: <LocalTime iso={app.since} /> },
        { key: "codes", label: COPY.backupCodesLeft, value: app.backupCodesLeft },
      ]} />
      {app.backupCodesLeft === 0 && <p>{COPY.backupCodesNone}</p>}
      {answered}
      <AskAgain email={email} proved={proved} section={COPY.appTitle} passkey={passkey} portalOrigin={portalOrigin}>
        <div className="stack">
          <Button variant="secondary" busy={busy === "codes"} aria-disabled={busy !== null || undefined} onClick={() => void newCodes()}>
            {busy === "codes" ? COPY.newCodesBusy : COPY.newCodes}
          </Button>
          {/* Under Strict the app stays while it is the only second step; beside a passkey (slice SI-7b) it can go. */}
          {strict && !passkey ? <p>{COPY.turnOffStrict}</p> : (
            <>
              <p>{passkey ? COPY.turnOffWordsBesidePasskey : COPY.turnOffWords}</p>
              <Button variant="danger" busy={busy === "off"} aria-disabled={busy !== null || undefined} onClick={() => void turnOff()}>
                {busy === "off" ? COPY.turnOffBusy : COPY.turnOff}
              </Button>
            </>
          )}
        </div>
      </AskAgain>
    </div>
  );
}
