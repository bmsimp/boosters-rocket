"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { parentAuthClient } from "@/lib/auth/client";
import { readCeremony, type CeremonyOutcome } from "@/app/sign-in/passkey-ceremony";
import { SIGNIN_SETTINGS_COPY as COPY, howYouSignIn, passkeysAddedOnlyAt } from "@/lib/parents/signin-settings-copy";
import { newBackupCodesAction, removePasskeyAction, renamePasskeyAction } from "./actions";
import { CopyButton } from "./authenticator-box";
import { passkeysAddIn, toPortalAdd } from "./passkey-adding";
import { AskAgain } from "./signin-forms";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const FAILED = { ok: false as const, errors: [COPY.failed] };
const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;
const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

/** A passkey as the page lists it (MyPasskey, src/lib/parents/signin-settings.ts): its row's id, its name, and its two times. */
export type ShownPasskey = { id: string; name: string | null; createdAt: string; lastUsedAt: string | null };
/** What the portal's add answers (addMyPasskey(), passkey-settings.ts). */
type AddAnswer = { ok: true; codes?: string[] } | { ok: false; error: "rejected" | "rate_limited" | "prove_again" | "already_added" };
type CodesResult = { ok: true; message: string; codes: string[] } | { ok: false; errors: string[] };

/** Calls `then` once, when it is drawn: AskAgain draws it once the parent has shown it's them. */
function WhenDrawn({ then }: { then: () => void }) {
  useEffect(() => { then(); }, [then]);
  return null;
}

/** The words of a refused add, by the portal's answer or the ceremony's outcome. */
function addRefusal(outcome: CeremonyOutcome<AddAnswer>): string {
  if (outcome.kind === "cancelled") return COPY.passkeyCancelled;
  // The options refused (a 404: no recent proof, or the session can't add one now): show it's them again.
  if (outcome.kind === "failed") return outcome.status === 404 ? COPY.proveAgain : COPY.failed;
  const a = outcome.body;
  if (a.ok) return COPY.failed;
  return a.error === "rate_limited" ? COPY.tooManyPresses : a.error === "prove_again" ? COPY.proveAgain : a.error === "already_added" ? COPY.passkeyAlready : COPY.passkeyRejected;
}

/**
 * The passkeys on the sign-in settings page (the sign-in release, slice SI-7b; src/lib/parents/passkey-settings.ts):
 * one sentence of what a passkey is, the list (each with its name, or "Passkey added" and its date, when it was added
 * and when last used), "Rename" on each (not asked again), and, asked again first (AskAgain, with the passkey itself for
 * a holder) unless the session proved itself in the last 10 minutes, "Remove" on each and "Add a passkey" with its
 * optional name. Adding is the passkey library's ceremony, its verify request sent to the portal's /portal-passkey/add
 * with the name (toPortalAdd()); a first passkey of a parent with no app answers ten backup codes, shown once, in this
 * component's state. Beside a passkey and no app, "Make new backup codes" too. Given only what it shows: the address for
 * AskAgain's username field, the listed passkeys, whether a password is chosen, whether the session proved itself,
 * whether the club is at Strict, whether they have an app, how many backup codes are left, and APP_URL's origin (where
 * a passkey can be added; reached at any other address, the box says so in place of the add press).
 */
export function PasskeyBox({ email, passkeys, proved, hasPassword, strict, app, backupCodesLeft, portalOrigin }: { email: string; passkeys: ShownPasskey[]; proved: boolean;
  hasPassword: boolean; strict: boolean; app: boolean; backupCodesLeft: number; portalOrigin: string }) {
  const router = useRouter();
  const words = howYouSignIn({ app, passkey: passkeys.length > 0 });
  const [provedHere, setProvedHere] = useState(false);
  const [where, setWhere] = useState<"here" | "unsupported" | "elsewhere">("here");
  useEffect(() => {
    // Known only in the browser, after mount: drawn as "here" first, so the server's page and the first draw agree.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setWhere(!passkeysAddIn(window as unknown as Parameters<typeof passkeysAddIn>[0]) ? "unsupported" : window.location.origin !== portalOrigin ? "elsewhere" : "here");
  }, [portalOrigin]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Result | null>(null);
  const [codes, setCodes] = useState<{ message: string; list: string[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const said = useRef<HTMLDivElement>(null);
  const codesLine = useRef<HTMLParagraphElement>(null);
  // "Rename" draws the name field in place of the buttons: the field takes the focus.
  const renameField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) renameField.current?.focus(); }, [renaming]);
  useEffect(() => { if (answer) said.current?.focus(); }, [answer]);
  useEffect(() => { if (codes) codesLine.current?.focus(); }, [codes]);
  const canChange = proved || provedHere;

  const add = async () => {
    if (busy) return;
    setBusy("add"); setAnswer(null);
    let outcome: CeremonyOutcome<AddAnswer>;
    try {
      outcome = readCeremony<AddAnswer>(await parentAuthClient.passkey.addPasskey(undefined, toPortalAdd(window.location.origin, name)));
    } catch {
      outcome = { kind: "failed", status: null };
    }
    setBusy(null);
    if (outcome.kind === "answer" && outcome.body.ok) {
      setName("");
      // The new passkey is now the newest way in, so this session's earlier proof no longer counts (decision 1): the
      // page drawn again asks again before the next change, offering the passkey.
      setProvedHere(false);
      if (outcome.body.codes) setCodes({ message: COPY.passkeyCodesMade, list: outcome.body.codes });
      else setAnswer({ ok: true, message: COPY.passkeyAdded });
      router.refresh();
      return;
    }
    setAnswer({ ok: false, errors: [addRefusal(outcome)] });
  };
  const rename = async (id: string) => {
    if (busy) return;
    setBusy(`rename:${id}`); setAnswer(null);
    const r: Result = await safely(() => renamePasskeyAction(id, newName), FAILED);
    setBusy(null);
    if (r.ok) setRenaming(null);
    setAnswer(r);
  };
  const remove = async (id: string) => {
    if (busy) return;
    setBusy(`remove:${id}`); setAnswer(null);
    const r: Result = await safely(() => removePasskeyAction(id), FAILED);
    setBusy(null);
    setAnswer(r);
  };
  const newCodes = async () => {
    if (busy) return;
    setBusy("codes"); setAnswer(null);
    const r: CodesResult = await safely(() => newBackupCodesAction(), FAILED);
    setBusy(null);
    if (!r.ok) { setAnswer(r); return; }
    setCodes({ message: r.message, list: r.codes });
  };

  const last = passkeys.length === 1;
  // Before the press, beside the last passkey (open question 33): what the second step will be afterwards.
  const lastWords = !last ? null : app ? COPY.passkeyRemoveLastAppWords : strict ? COPY.passkeyRemoveStrict : COPY.passkeyRemoveLastWords;

  return (
    <div className="stack">
      <p>{COPY.passkeysWhat}</p>
      {codes && (
        <div className="stack">
          <p ref={codesLine} role="status" tabIndex={-1} className="paid-up"><Tick />{codes.message}</p>
          <h3>{COPY.backupCodesTitle}</h3>
          <p>{app ? COPY.backupCodesKeep : COPY.backupCodesKeepPasskey}</p>
          <ul className="backup-codes" aria-label={COPY.backupCodesTitle}>
            {codes.list.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <CopyButton text={codes.list.join("\n")} label={COPY.copyCodes} />
        </div>
      )}
      {answer && (
        <div ref={said} tabIndex={-1}>
          {answer.ok ? <p role="status" className="paid-up"><Tick />{answer.message}</p> : <Errors errors={answer.errors} />}
        </div>
      )}
      {passkeys.length === 0 ? <p>{COPY.passkeysNone}</p> : (
        <ul className="stack">
          {passkeys.map((k) => (
            <li key={k.id}>
              <p><strong>{k.name ?? <>{COPY.passkeyNoName} <LocalTime iso={k.createdAt} /></>}</strong></p>
              <dl className="details">
                <dt>{COPY.passkeyAddedOn}</dt><dd><LocalTime iso={k.createdAt} /></dd>
                <dt>{COPY.passkeyLastUsed}</dt><dd>{k.lastUsedAt ? <LocalTime iso={k.lastUsedAt} /> : COPY.passkeyNotUsed}</dd>
              </dl>
              {renaming === k.id ? (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); void rename(k.id); }}>
                  <label className="field"><span>{COPY.passkeyRenameLabel}</span>
                    <input name="passkey-name" maxLength={50} value={newName} onChange={(e) => setNewName(e.target.value)} ref={renameField} />
                  </label>
                  <button className="btn" aria-disabled={busy !== null || undefined}>{busy === `rename:${k.id}` ? COPY.passkeyRenameBusy : COPY.passkeyRenameSave}</button>
                  <button type="button" className="btn btn-line" onClick={() => setRenaming(null)}>{COPY.passkeyRenameCancel}</button>
                </form>
              ) : (
                <div className="box-foot">
                  <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined}
                    onClick={() => { setNewName(k.name ?? ""); setRenaming(k.id); }}>{COPY.passkeyRename}<span className="visually-hidden"> {k.name ?? COPY.passkeyNoName}</span></button>
                  {canChange && !(last && strict && !app) && (
                    <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined} onClick={() => void remove(k.id)}>
                      {busy === `remove:${k.id}` ? COPY.passkeyRemoveBusy : COPY.passkeyRemove}<span className="visually-hidden"> {k.name ?? COPY.passkeyNoName}</span>
                    </button>
                  )}
                </div>
              )}
              {canChange && lastWords && <p className="help">{lastWords}</p>}
            </li>
          ))}
        </ul>
      )}
      {passkeys.length > 0 && !app && <p className="help">{COPY.backupCodesLeft}: {backupCodesLeft}</p>}
      {!hasPassword ? <p>{COPY.passkeyNeedsPassword}</p> : !canChange ? (
        <AskAgain email={email} proved={false} lede={words.askAgainForPasskeys} passkey={passkeys.length > 0} portalOrigin={portalOrigin}>
          <WhenDrawn then={() => setProvedHere(true)} />
        </AskAgain>
      ) : (
        <div className="stack">
          {passkeys.length > 0 && !app && (
            <button type="button" className="btn btn-line" aria-disabled={busy !== null || undefined} onClick={() => void newCodes()}>
              {busy === "codes" ? COPY.newCodesBusy : COPY.newCodes}
            </button>
          )}
          {where === "here" ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <label className="field"><span>{COPY.passkeyName}</span>
                <input name="passkey-name" maxLength={50} autoComplete="off" aria-describedby="passkey-name-help" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <p className="help" id="passkey-name-help">{COPY.passkeyNameHelp}</p>
              {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
              <button className="btn" aria-disabled={busy !== null || undefined}>{busy === "add" ? COPY.passkeyAddBusy : COPY.passkeyAdd}</button>
            </form>
          ) : <p>{where === "elsewhere" ? passkeysAddedOnlyAt(portalOrigin) : COPY.passkeysUnsupported}</p>}
        </div>
      )}
    </div>
  );
}
