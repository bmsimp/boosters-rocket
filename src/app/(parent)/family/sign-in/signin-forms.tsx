"use client";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { safely } from "@/app/components/action-error";
import { parentAuthClient } from "@/lib/auth/client";
import { passkeysWorkIn, readCeremony, type CeremonyOutcome } from "@/app/sign-in/passkey-ceremony";
import { PASSKEY_STEP_UNSUPPORTED, passkeyStepElsewhere } from "@/lib/parents/signin-copy";
import { toPortalAgain } from "./passkey-adding";
import { LocalTime } from "@/app/components/local-time";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { SIGNIN_SETTINGS_COPY as COPY, howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { askAgainCodeAction, askAgainPasswordAction, askSetupLinkAction, changePasswordAction, forgetDeviceAction, forgetOtherDevicesAction, signOutEverywhereAction } from "./actions";

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
export function Said({ message, children }: { message: string; children?: ReactNode }) {
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
 * proved itself in the last 10 minutes is asked for the password, then for the code it emails, or (since slice SI-6a,
 * when the server's answer says so) the code of the parent's authenticator app or a backup code. `proved` is what the
 * page read for this session; `children` is the change itself, drawn once proved. Given only what it shows: the address
 * (for a password manager's username field) and the words of its lede. Between the two steps it keeps the stamp the
 * server answered with, which names nothing, and sends it back with the code.
 *
 * Since slice SI-7b, for a parent with a passkey (`passkey`), "Use your passkey" comes first, the password beside it:
 * the passkey library's ceremony, its verify request sent to the portal's /portal-passkey/again (toPortalAgain()),
 * which proves this session alone. After the password such a parent is asked for the passkey again (the server's
 * `step: "passkey"`), with the app's code or a backup code beside it when they have an app, or a backup code alone when
 * they hold unspent ones and no app (`backupCodes`). `portalOrigin` is APP_URL's
 * origin, where passkeys work: reached at any other address, the form says so in place of the button.
 */
export function AskAgain({ email, proved, lede, children, passkey = false, portalOrigin = "" }: { email: string; proved: boolean; lede: string; children: ReactNode;
  passkey?: boolean; portalOrigin?: string }) {
  const [step, setStep] = useState<"password" | "code" | "app" | "passkey" | "proved" | "arrived">(proved ? "proved" : "password");
  // At the passkey's step after the password: what is taken beside it, the app's code or a backup code (`app`), a
  // backup code alone (`codes`), or nothing.
  const [beside, setBeside] = useState<"app" | "codes" | null>(null);
  // Where a passkey can be used from this page: here, not in this browser, or not at this address (read once drawn).
  const [keysHere, setKeysHere] = useState<"here" | "unsupported" | "elsewhere">("here");
  useEffect(() => {
    if (!passkey) return;
    // Known only in the browser, after mount: drawn as "here" first, so the server's page and the first draw agree.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setKeysHere(!passkeysWorkIn(window as unknown as Parameters<typeof passkeysWorkIn>[0]) ? "unsupported" : window.location.origin !== portalOrigin ? "elsewhere" : "here");
  }, [passkey, portalOrigin]);
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stamp, setStamp] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[] | null>(null);
  // Moving between the steps draws the other form, so its field takes the focus (not on first drawing).
  const field = useRef<HTMLInputElement>(null);
  // The passkey's step with nothing beside it has no field: its words take the focus instead.
  const stepLine = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  // The code field is described by the words that say a code was emailed: a live region drawn with its words already
  // in it is seldom read out, so the field that takes the focus carries them.
  const sentId = useId();
  useEffect(() => { if (moved.current) (field.current ?? stepLine.current)?.focus(); }, [step]);
  // A proof that stops counting while the page is open (since slice SI-6b's second read: an authenticator app set up
  // on this page, which leaves every earlier proof of the person behind) reaches here as `proved` turning false once
  // the page is drawn again: a change drawn for that proof gives way to the password, so the page never offers a press
  // the server will refuse. Only a turn from true to false does this, never a first drawing or a proof just made here.
  const [wasProved, setWasProved] = useState(proved);
  if (proved !== wasProved) {
    setWasProved(proved);
    if (!proved && (step === "proved" || step === "arrived")) { setErrors(null); setStep("password"); }
  }
  // A proof made elsewhere on the page (the devices box's own asking again) reaches here as `proved` once the page is
  // drawn again: a password step not yet answered gives way to the change, so it never asks for what was just shown.
  if (step === "proved" || (step === "password" && proved)) return <>{children}</>;
  if (step === "arrived") return <Said message={COPY.proved}>{children}</Said>;

  const checkPassword = async () => {
    setBusy(true); setErrors(null);
    const r = await safely(() => askAgainPasswordAction(password), { ok: false as const, errors: [COPY.failed] });
    setBusy(false);
    if (!r.ok) { setErrors(r.errors); return; }
    // The server says which second step: the code it emailed, (slice SI-6a) the parent's authenticator app, or (slice
    // SI-7b) their passkey, with the app beside it when they have one.
    moved.current = true; setStamp(r.stamp); setPassword(""); setCode("");
    if (r.step === "passkey") { setBeside(r.app ? "app" : r.backupCodes ? "codes" : null); setStep("passkey"); return; }
    setStep(r.step === "app" ? "app" : "code");
  };
  // A passkey (slice SI-7b): the library's ceremony, its verify request sent to the portal's asking again. A proof
  // redraws the page from the server, so every box of it sees this session proved.
  const provePasskey = async () => {
    setBusy(true); setErrors(null);
    let outcome: CeremonyOutcome<{ ok: boolean }>;
    try {
      outcome = readCeremony<{ ok: boolean }>(await parentAuthClient.signIn.passkey({ fetchOptions: toPortalAgain(window.location.origin) }));
    } catch {
      outcome = { kind: "failed", status: null };
    }
    setBusy(false);
    if (outcome.kind === "answer" && outcome.body.ok) { setStamp(""); setCode(""); setStep("arrived"); router.refresh(); return; }
    setErrors([outcome.kind === "cancelled" ? COPY.passkeyAgainCancelled : outcome.kind === "answer" ? COPY.passkeyAgainRejected : COPY.failed]);
  };
  const passkeyPress = passkey && (keysHere === "here"
    ? <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => { if (!busy) void provePasskey(); }}>{busy ? COPY.checking : COPY.usePasskey}</button>
    : <p className="help">{keysHere === "elsewhere" ? passkeyStepElsewhere(portalOrigin) : PASSKEY_STEP_UNSUPPORTED}</p>);
  const checkCode = async () => {
    setBusy(true); setErrors(null);
    const r: Result & { ended?: true } = await safely(() => askAgainCodeAction(stamp, code), FAILED);
    setBusy(false);
    // The app's step can't go on (since slice SI-6b; the server never says why): back to the password, with the words.
    if (!r.ok && r.ended) { moved.current = true; setStamp(""); setCode(""); setPassword(""); setErrors(r.errors); setStep("password"); return; }
    if (!r.ok) { setErrors(r.errors); return; }
    setStamp(""); setCode(""); setStep("arrived");
  };
  // Starting again keeps nothing of the step it leaves.
  const startAgain = () => { moved.current = true; setStamp(""); setCode(""); setPassword(""); setErrors(null); setStep("password"); };

  if (step === "password") {
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void checkPassword(); }}>
        <p>{lede}</p>
        {/* A passkey holder's passkey first (slice SI-7b), the password beside it. */}
        {passkeyPress}
        {passkey && <p>{COPY.orPassword}</p>}
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
  // The passkey's step after the password (slice SI-7b): the passkey, and beside it an app's code or a backup code.
  if (step === "passkey" && !beside) {
    return (
      <div className="stack">
        <p ref={stepLine} role="status" tabIndex={-1}>{COPY.passkeyAsked}</p>
        {passkeyPress}
        {errors && <Errors errors={errors} />}
        <button type="button" className="btn btn-line" onClick={startAgain}>{COPY.startAgain}</button>
      </div>
    );
  }
  // The app's step takes a backup code in the same field, so its keyboard is a text one, not digits alone.
  const app = step === "app" || step === "passkey";
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!busy) void checkCode(); }}>
      <p role="status" id={sentId}>{step === "passkey" ? (beside === "app" ? COPY.passkeyOrAppAsked : COPY.passkeyOrBackupAsked) : app ? COPY.appAsked : COPY.codeSent}</p>
      {step === "passkey" && passkeyPress}
      <label className="field"><span>{step === "passkey" && beside === "codes" ? COPY.backupCode : app ? COPY.appCode : COPY.code}</span>
        {app
          ? <input ref={field} name="code" aria-describedby={sentId} inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            autoComplete="one-time-code" maxLength={20} required value={code} onChange={(e) => setCode(e.target.value)} />
          : <input ref={field} name="code" aria-describedby={sentId} inputMode="numeric" autoComplete="one-time-code" maxLength={9} required value={code} onChange={(e) => setCode(e.target.value)} />}
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
 * `app`: whether the parent has an authenticator app (slice SI-6b), for the words of how they sign in again.
 */
export function ChangePasswordForm({ email, app, passkey = false }: { email: string; app: boolean; passkey?: boolean }) {
  const words = howYouSignIn({ app, passkey });
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const signedOut = useContext(SignedOutContext);
  if (result?.ok) return <SignedOut message={result.message} next={words.changedNext} signIn={{ href: "/sign-in", label: COPY.signIn }} />;
  const change = async () => {
    setBusy(true); setResult(null);
    const r = await safely(() => changePasswordAction(password, again), FAILED);
    setBusy(false);
    if (r.ok && signedOut) { signedOut({ message: r.message, next: words.changedNext, signIn: { href: "/sign-in", label: COPY.signIn } }); return; }
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
      <p>{words.signsOutEverywhere}</p>
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

/**
 * A remembered device as the page lists it (MyDevice, src/lib/parents/signin-settings.ts): its row's id (its forget
 * button's value, the only id the page sends), whether this session was made on it, and its two times as ISO strings.
 */
export type ListedDevice = { id: string; thisOne: boolean; createdAt: string; lastUsedAt: string };

/** Calls `then` once, when it is drawn: AskAgain draws it once the parent has shown it's them. */
function WhenDrawn({ then }: { then: () => void }) {
  useEffect(() => { then(); }, [then]);
  return null;
}

/** Two devices whose two times read the same to the minute, as LocalTime draws them: their buttons' names add the row. */
const sameMinutes = (a: ListedDevice, b: ListedDevice) => a.createdAt.slice(0, 16) === b.createdAt.slice(0, 16) && a.lastUsedAt.slice(0, 16) === b.lastUsedAt.slice(0, 16);

/**
 * The remembered devices (slice SI-5b), newest use first, the one this session was made on marked "This device". Each
 * can be forgotten, and every other one at once, but only by a session that showed it's the parent in the last 10
 * minutes: otherwise the list is drawn without its buttons and asking again below it (AskAgain; `canAsk` false, for a
 * parent with no password or under Strict, draws `cantAsk`'s words instead). Given only the listed devices, whether
 * this session proved itself, the address for AskAgain's username field and those words.
 *
 * Each button says which device it forgets: "Forget this device" on the session's own row, and on every other "Forget"
 * with, in its name, the two times the row shows ("the device first remembered …, last used …"; the row's place in the
 * list too when another row's times read the same), so no two buttons share a name. A session that names none of them
 * can't say which is the one in use: the box says so above the list, and the button for all of them is "Forget every
 * device". A session whose own device was just forgotten in this box knows the rest are the others, and keeps "Forget
 * every other device" without that sentence.
 */
export function RememberedDevices({ devices, proved, canAsk, cantAsk, email, app, passkey = false, portalOrigin = "" }: { devices: ListedDevice[]; proved: boolean;
  canAsk: boolean; cantAsk: string; email: string; app: boolean; passkey?: boolean; portalOrigin?: string }) {
  // What the next sign-in on a forgotten device asks for: their passkey (slice SI-7b), the code from their authenticator app (slice SI-6b), or ours.
  const words = howYouSignIn({ app, passkey });
  // Proved here, by the asking below: it gives way to its thanks, drawn above the list, and the buttons come after it.
  // Proved in another box of the page, the page is drawn again with `proved` (the proof revalidates it), and the
  // asking here simply goes.
  const [provedHere, setProvedHere] = useState(false);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  // Forgotten here: the device this session names, once its own button's press went through. The forget redraws the
  // page (it revalidates it), and the session then names no device (its `device_id` went null with the row), so the
  // redrawn list marks none: this is how the box still knows the rest are the other devices.
  const [forgotThisOne, setForgotThisOne] = useState(false);
  const said = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (result) said.current?.focus(); }, [result]);
  const listed = devices.filter((d) => !gone.has(d.id));
  const canForget = proved || provedHere;
  const others = listed.filter((d) => !d.thisOne);
  // Whether the session names one of the listed devices, or named the one just forgotten here: then the rest are "every
  // other device", and the box never says it can't tell which is the one in use.
  const knowsThisOne = forgotThisOne || devices.some((d) => d.thisOne);

  const forget = async (which: "one" | "others", id?: string) => {
    if (busy) return;
    const wasThisOne = which === "one" && devices.some((d) => d.id === id && d.thisOne);
    setBusy(which === "one" ? id! : "others"); setResult(null);
    const r = await safely(() => (which === "one" ? forgetDeviceAction(id!) : forgetOtherDevicesAction()), FAILED);
    setBusy(null);
    if (r.ok) {
      setGone((g) => new Set([...g, ...(which === "one" ? [id!] : others.map((d) => d.id))]));
      if (wasThisOne) setForgotThisOne(true);
    }
    setResult(r);
  };

  return (
    <div className="stack">
      <p>{words.devicesLede}</p>
      <p className="help">{COPY.devicesNoNames}</p>
      {provedHere && <Said message={COPY.proved} />}
      {result && (result.ok
        ? <p ref={said} role="status" tabIndex={-1} className="paid-up"><Tick />{result.message}</p>
        : <div ref={said} tabIndex={-1}><Errors errors={result.errors} /></div>)}
      {listed.length === 0 ? <p>{words.devicesNone}</p> : (
        <>
          {!knowsThisOne && <p>{COPY.devicesWhichUnknown}</p>}
          <ul className="stack">
            {listed.map((d, i) => (
              <li key={d.id} data-device={d.id}>
                {d.thisOne && <p><strong>{COPY.thisDevice}</strong></p>}
                <dl className="details">
                  <dt>{COPY.firstRemembered}</dt><dd><LocalTime iso={d.createdAt} /></dd>
                  <dt>{COPY.lastUsed}</dt><dd><LocalTime iso={d.lastUsedAt} /></dd>
                </dl>
                {canForget && (
                  <div className="box-foot">
                    <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined} onClick={() => void forget("one", d.id)}>
                      {busy === d.id ? COPY.forgetBusy : d.thisOne ? COPY.forgetDevice : COPY.forgetOne}
                      {!d.thisOne && (
                        <span className="visually-hidden">
                          {" "}{COPY.forgetWhichFirst} <LocalTime iso={d.createdAt} />, {COPY.forgetWhichLast} <LocalTime iso={d.lastUsedAt} />
                          {listed.some((o) => o.id !== d.id && !o.thisOne && sameMinutes(o, d)) && <>, {COPY.forgetWhichRow} {i + 1}</>}
                        </span>
                      )}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {listed.some((d) => d.thisOne) && <p className="help">{words.forgetHere}</p>}
      {canForget && others.length > 0 && listed.length > 1 && (
        <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined}
          onClick={() => void forget("others")}>{busy === "others" ? COPY.forgetBusy : knowsThisOne ? COPY.forgetOthers : COPY.forgetAll}</button>
      )}
      {!canForget && listed.length > 0 && (canAsk
        ? <AskAgain email={email} proved={false} lede={words.askAgainForDevices} passkey={passkey} portalOrigin={portalOrigin}><WhenDrawn then={() => setProvedHere(true)} /></AskAgain>
        : <p>{cantAsk}</p>)}
    </div>
  );
}
