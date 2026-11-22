"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { safely } from "@/app/components/action-error";
import { ENROLMENT_COPY as WORDS } from "@/lib/parents/enrolment-copy";
import { BackupCodesShown, addPasskeyHere } from "@/app/(parent)/family/sign-in/passkey-add";
import { Notice } from "@/app/components/ui";
import { passkeysAddIn } from "@/app/(parent)/family/sign-in/passkey-adding";
import { AppSetupForm, type AppSetupShown } from "@/app/(parent)/family/sign-in/app-setup";
import type { EnrolmentAppConfirm, EnrolmentAppStart } from "./actions";

const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;
/**
 * A press that threw: a lost connection, the server, or the gate's refusal of a session no longer enrolling (whole from
 * another tab, or ended). One answer true of each, in the box, which stays: a reload shows where things stand.
 */
const THREW = { ok: false as const, errors: [WORDS.failed] };
type Busy = "passkey" | "start" | "confirm" | null;
type Done = { kind: "passkey" | "app"; codes: string[] | null };
type Setup = AppSetupShown & { stamp: string };

/**
 * Strict's enrolment in the browser (/one-more-step; the sign-in release, slice SI-10a): two boxes, a passkey and an
 * authenticator app, from SI-7b's and SI-6b's own parts. The passkey box adds through SI-7b's add unchanged
 * (addPasskeyHere(), with no name), drawn only in a browser with WebAuthn at the portal's own address, which it learns
 * after mount (as the passkey offer on Home does), and otherwise says the app is the way. The app box runs SI-6b's
 * set-up through the page's own actions, given bound on the server. Once a factor is in force the session is whole,
 * and the page shows its done words and the ten backup codes, once, focused; under them a box to tick that they were
 * saved, and Continue, `aria-disabled` until it is ticked, which goes to `next` (the page asked for, through
 * safeReturnPath() on the server, or home), where the gate takes over. The confirm is this page's alone: kept nowhere.
 * Given only the portal's origin, the actions and `next`: no address, no name, no family, no count.
 */
export function EnrolmentSteps({ portalOrigin, next, startApp, confirmApp }: { portalOrigin: string; next: string | null;
  startApp: () => Promise<EnrolmentAppStart>; confirmApp: (code: string, stamp: string) => Promise<EnrolmentAppConfirm> }) {
  // Known only in the browser, after mount: whether this browser can add a passkey here.
  const [canPasskey, setCanPasskey] = useState<boolean | null>(null);
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setCanPasskey(passkeysAddIn(window as unknown as Parameters<typeof passkeysAddIn>[0]) && window.location.origin === portalOrigin);
  }, [portalOrigin]);
  const [busy, setBusy] = useState<Busy>(null);
  const [passkeyErrors, setPasskeyErrors] = useState<string[] | null>(null);
  const [appErrors, setAppErrors] = useState<string[] | null>(null);
  // The words of a refusal that means signing in again (the actions' own, true of why), and only those are drawn then.
  const [signInAgain, setSignInAgain] = useState<string[] | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [ticked, setTicked] = useState(false);
  const [nudge, setNudge] = useState("");
  // Where the focus lands after a press that draws something new: the words at the top of what it drew.
  const landing = useRef<HTMLParagraphElement>(null);
  const said = useRef<HTMLDivElement>(null);
  const refusal = useRef<HTMLDivElement>(null);
  const appAnswer = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState(0);
  // A set-up found over takes its form and focused button away: the focus goes to the answer that says so.
  const [setupEnded, setSetupEnded] = useState(0);
  useEffect(() => { if (landed) landing.current?.focus(); }, [landed]);
  useEffect(() => { if (setupEnded) appAnswer.current?.focus(); }, [setupEnded]);
  useEffect(() => { if (done) said.current?.focus(); }, [done]);
  useEffect(() => { if (signInAgain) refusal.current?.focus(); }, [signInAgain]);

  const addPasskey = async () => {
    if (busy) return;
    setBusy("passkey"); setPasskeyErrors(null);
    const added = await addPasskeyHere("");
    setBusy(null);
    if (added.ok) { setDone({ kind: "passkey", codes: added.codes ?? null }); return; }
    // The options or the add refused for want of a proof: the session may no longer add one (its window passed, a
    // factor came through another session, or the level changed). The browser can't tell which: words true of each.
    if (added.proveAgain) { setSignInAgain([WORDS.signInAgain]); return; }
    setPasskeyErrors([added.error]);
  };
  const start = async () => {
    if (busy) return;
    setBusy("start"); setAppErrors(null);
    const r = await safely<EnrolmentAppStart>(() => startApp(), THREW);
    setBusy(null);
    if (!r.ok) { if ("signInAgain" in r) setSignInAgain(r.errors); else setAppErrors(r.errors); return; }
    setCode(""); setSetup({ key: r.key, qr: r.qr, stamp: r.stamp }); setLanded((n) => n + 1);
  };
  const confirm = async () => {
    if (busy || !setup) return;
    setBusy("confirm"); setAppErrors(null);
    const r = await safely<EnrolmentAppConfirm>(() => confirmApp(code, setup.stamp), THREW);
    setBusy(null);
    if (!r.ok) {
      if ("signInAgain" in r) { setSetup(null); setSignInAgain(r.errors); return; }
      setAppErrors(r.errors);
      // Nothing left to finish (run out, replaced, or finished in another window): the dead QR code and key go.
      if ("setupOver" in r && r.setupOver) { setSetup(null); setCode(""); setSetupEnded((n) => n + 1); }
      return;
    }
    setSetup(null); setCode(""); setDone({ kind: "app", codes: r.codes });
  };
  const goOn = () => {
    if (done?.codes && !ticked) { setNudge(WORDS.tickFirst); return; }
    window.location.assign(next ?? "/");
  };

  if (signInAgain) {
    return (
      <div ref={refusal} tabIndex={-1} className="stack">
        <Errors errors={signInAgain} />
        <p><Link className="link-line" href="/sign-in">{WORDS.signIn}</Link></p>
      </div>
    );
  }

  if (done) {
    const words = done.kind === "passkey" ? WORDS.donePasskey : WORDS.doneApp;
    return (
      <div className="stack enrolment-done">
        {done.codes ? (
          <BackupCodesShown message={words} list={done.codes} app={done.kind === "app"} lineRef={said} heading={2}
            keep={done.kind === "passkey" ? WORDS.backupCodesKeepPasskey : undefined} />
        ) : <Notice tone="done" ref={said} tabIndex={-1}>{words}</Notice>}
        <form className="stack" onSubmit={(e) => { e.preventDefault(); goOn(); }}>
          {done.codes && (
            <div className="checks">
              <label>
                <input type="checkbox" name="saved" checked={ticked} onChange={(e) => { setTicked(e.target.checked); if (e.target.checked) setNudge(""); }} />
                <span>{WORDS.saved}</span>
              </label>
            </div>
          )}
          {/* aria-disabled, never disabled: a press while unticked says why, and the focus stays on the button. */}
          <button className="btn" aria-disabled={(done.codes !== null && !ticked) || undefined}>{WORDS.continue}</button>
          <p role="status" className="help">{nudge}</p>
        </form>
      </div>
    );
  }

  return (
    <div className="stack enrolment">
      <section className="box" aria-labelledby="enrol-passkey-h">
        <h2 id="enrol-passkey-h">{WORDS.passkeyTitle}</h2>
        <p>{WORDS.passkeyWhat}</p>
        {canPasskey === false && <p>{WORDS.passkeyNotHere}</p>}
        {canPasskey && (
          <div className="box-foot">
            <button type="button" className="btn" aria-disabled={busy !== null || undefined} onClick={() => void addPasskey()}>
              {busy === "passkey" ? WORDS.passkeyAddBusy : WORDS.passkeyAdd}
            </button>
          </div>
        )}
        {passkeyErrors && <Errors errors={passkeyErrors} />}
      </section>
      <section className="box" aria-labelledby="enrol-app-h">
        <h2 id="enrol-app-h">{WORDS.appTitle}</h2>
        {setup ? (
          <AppSetupForm setup={setup} code={code} onCode={setCode} onConfirm={() => void confirm()} busy={busy === "confirm"}
            answered={appErrors && <Errors errors={appErrors} />} landing={landing} lost={WORDS.appSetupLost} />
        ) : (
          <>
            <p>{WORDS.appWhat}</p>
            {appErrors && <div ref={appAnswer} tabIndex={-1}><Errors errors={appErrors} /></div>}
            <div className="box-foot">
              <button type="button" className="btn" aria-disabled={busy !== null || undefined} onClick={() => void start()}>
                {busy === "start" ? WORDS.appSetUpBusy : WORDS.appSetUp}
              </button>
            </div>
          </>
        )}
      </section>
      {/* Only while the step is still to do: once a factor is in force, signing out no longer brings it back. */}
      <p className="help">{WORDS.foot}</p>
    </div>
  );
}
