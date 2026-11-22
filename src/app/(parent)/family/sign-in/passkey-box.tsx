"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { ActionOutcome, Button, List, ListRow, TextInput } from "@/app/components/ui";
import { SIGNIN_SETTINGS_COPY as COPY, howYouSignIn, passkeysAddedOnlyAt } from "@/lib/parents/signin-settings-copy";
import { newBackupCodesAction, removePasskeyAction, renamePasskeyAction } from "./actions";
import { BackupCodesShown, CodesSaved, addPasskeyHere } from "./passkey-add";
import { passkeysAddIn } from "./passkey-adding";
import { AskAgain, Said } from "./signin-forms";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const FAILED = { ok: false as const, errors: [COPY.failed] };

/** A passkey as the page lists it (MyPasskey, src/lib/parents/signin-settings.ts): its row's id, its name, and its two times. */
export type ShownPasskey = { id: string; name: string | null; createdAt: string; lastUsedAt: string | null };
type CodesResult = { ok: true; message: string; codes: string[] } | { ok: false; errors: string[] };

/** Calls `then` once, when it is drawn: AskAgain draws it once the parent has shown it's them. */
function WhenDrawn({ then }: { then: () => void }) {
  useEffect(() => { then(); }, [then]);
  return null;
}

/**
 * The passkeys on the sign-in settings page (the sign-in release, slice SI-7b; src/lib/parents/passkey-settings.ts):
 * one sentence of what a passkey is, the list (each with its name, or "Passkey added" and its date, when it was added
 * and when last used), "Rename" on each (not asked again), and, asked again first (AskAgain, with the passkey itself for
 * a holder) unless the session proved itself in the last 10 minutes, "Remove" on each and "Add a passkey" with its
 * optional name. Adding is the passkey library's ceremony, its verify request sent to the portal's /portal-passkey/add
 * with the name (toPortalAdd(); the ceremony and its outcome's words are shared with the passkey offer on Home,
 * addPasskeyHere(), ./passkey-add.tsx); a first passkey of a parent with no app answers ten backup codes, shown once, in this
 * component's state (BackupCodesShown). Beside a passkey and no app, "Make new backup codes" too. Given only what it shows: the address for
 * AskAgain's username field, the listed passkeys, whether a password is chosen, whether the session proved itself,
 * whether the club is at Strict, whether they have an app, how many backup codes are left, and APP_URL's origin (where
 * a passkey can be added; reached at any other address, the box says so in place of the add press). Since slice SI-10b,
 * under Strict, backup codes shown here stay until the parent ticks that they saved them and presses Done (CodesSaved).
 */
export function PasskeyBox({ email, passkeys, proved, hasPassword, strict, app, backupCodesLeft, portalOrigin }: { email: string; passkeys: ShownPasskey[]; proved: boolean;
  hasPassword: boolean; strict: boolean; app: boolean; backupCodesLeft: number; portalOrigin: string }) {
  const router = useRouter();
  const words = howYouSignIn({ app, passkey: passkeys.length > 0, strict });
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
  // "Cancel" draws the buttons again: the passkey's own "Rename" takes the focus back, so the keyboard keeps its place.
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const backTo = useRef<string | null>(null);
  useEffect(() => {
    if (renaming) { renameField.current?.focus(); return; }
    if (backTo.current) { renameButtons.current.get(backTo.current)?.focus(); backTo.current = null; }
  }, [renaming]);
  useEffect(() => { if (answer) said.current?.focus(); }, [answer]);
  useEffect(() => { if (codes) codesLine.current?.focus(); }, [codes]);
  const canChange = proved || provedHere;

  const add = async () => {
    if (busy) return;
    setBusy("add"); setAnswer(null);
    const added = await addPasskeyHere(name);
    setBusy(null);
    if (added.ok) {
      setName("");
      // The new passkey is now the newest way in, so this session's earlier proof no longer counts (decision 1): the
      // page drawn again asks again before the next change, offering the passkey.
      setProvedHere(false);
      if (added.codes) setCodes({ message: COPY.passkeyCodesMade, list: added.codes });
      else setAnswer({ ok: true, message: COPY.passkeyAdded });
      router.refresh();
      return;
    }
    setAnswer({ ok: false, errors: [added.error] });
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
  const lastWords = !last ? null : app ? (strict ? COPY.passkeyRemoveLastAppWordsStrict : COPY.passkeyRemoveLastAppWords)
    : strict ? COPY.passkeyRemoveStrict : COPY.passkeyRemoveLastWords;

  return (
    <div className="stack">
      <p>{COPY.passkeysWhat}</p>
      {codes && <BackupCodesShown message={codes.message} list={codes.list} app={app} lineRef={codesLine} />}
      {/* Under Strict (open question 25; slice SI-10b): put away once the parent says they saved them, and the box says so. */}
      {/* Keyed by the list: a new set of codes (new codes pressed again, or another passkey's) starts unticked. */}
      {codes && strict && <CodesSaved key={codes.list.join(" ")} onDone={() => { setCodes(null); setAnswer({ ok: true, message: COPY.codesPutAway }); }} />}
      <ActionOutcome ref={said} state={answer} />
      {passkeys.length === 0 ? <p>{COPY.passkeysNone}</p> : (
        // A row each: its name (or "Passkey added" and its date), when it was added and last used, and Rename and
        // Remove. Renaming draws the name field under the row, in place of the buttons.
        <List className="passkeys">
          {passkeys.map((k) => (
            <ListRow key={k.id} title={<span className="passkey-name"><strong>{k.name ?? <>{COPY.passkeyNoName} <LocalTime iso={k.createdAt} /></>}</strong></span>}
              meta={[
                <span key="added">{COPY.passkeyAddedOn} <LocalTime iso={k.createdAt} /></span>,
                <span key="used">{COPY.passkeyLastUsed} {k.lastUsedAt ? <LocalTime iso={k.lastUsedAt} /> : COPY.passkeyNotUsed}</span>,
              ]}
              action={renaming !== k.id && (
                <>
                  <Button size="sm" variant="secondary" aria-disabled={busy !== null || undefined}
                    ref={(el: HTMLButtonElement | null) => { if (el) renameButtons.current.set(k.id, el); else renameButtons.current.delete(k.id); }}
                    onClick={() => { setNewName(k.name ?? ""); setRenaming(k.id); }}>{COPY.passkeyRename}<span className="visually-hidden"> {k.name ?? COPY.passkeyNoName}</span></Button>
                  {canChange && !(last && strict && !app) && (
                    <Button size="sm" variant="danger" busy={busy === `remove:${k.id}`} aria-disabled={busy !== null || undefined} onClick={() => void remove(k.id)}>
                      {busy === `remove:${k.id}` ? COPY.passkeyRemoveBusy : COPY.passkeyRemove}<span className="visually-hidden"> {k.name ?? COPY.passkeyNoName}</span>
                    </Button>
                  )}
                </>
              )}
              detail={(renaming === k.id || (canChange && lastWords)) && (
                <>
                  {renaming === k.id && (
                    <form className="stack" onSubmit={(e) => { e.preventDefault(); void rename(k.id); }}>
                      <TextInput id={`passkey-rename-${k.id}`} label={COPY.passkeyRenameLabel} ref={renameField} name="passkey-name" maxLength={50} value={newName}
                        onChange={(e) => setNewName(e.target.value)} />
                      <div className="row-actions">
                        <Button type="submit" busy={busy === `rename:${k.id}`} aria-disabled={busy !== null || undefined}>{busy === `rename:${k.id}` ? COPY.passkeyRenameBusy : COPY.passkeyRenameSave}</Button>
                        <Button variant="secondary" onClick={() => { backTo.current = k.id; setRenaming(null); }}>{COPY.passkeyRenameCancel}</Button>
                      </div>
                    </form>
                  )}
                  {canChange && lastWords && <p className="help">{lastWords}</p>}
                </>
              )} />
          ))}
        </List>
      )}
      {passkeys.length > 0 && !app && <p className="help">{COPY.backupCodesLeft}: {backupCodesLeft}</p>}
      {/* Proved here, by the asking below: AskAgain gives way to the change at once, so its thanks is drawn here, and keeps the focus. */}
      {provedHere && <Said message={COPY.proved} />}
      {!hasPassword ? <p>{COPY.passkeyNeedsPassword}</p> : !canChange ? (
        <AskAgain email={email} proved={false} lede={words.askAgainForPasskeys} passkey={passkeys.length > 0} portalOrigin={portalOrigin}>
          <WhenDrawn then={() => setProvedHere(true)} />
        </AskAgain>
      ) : (
        <div className="stack">
          {passkeys.length > 0 && !app && (
            <Button variant="secondary" busy={busy === "codes"} aria-disabled={busy !== null || undefined} onClick={() => void newCodes()}>
              {busy === "codes" ? COPY.newCodesBusy : COPY.newCodes}
            </Button>
          )}
          {where === "here" ? (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <TextInput id="passkey-name" label={COPY.passkeyName} hint={COPY.passkeyNameHelp} name="passkey-name" maxLength={50} autoComplete="off"
                value={name} onChange={(e) => setName(e.target.value)} />
              {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
              <Button type="submit" busy={busy === "add"} aria-disabled={busy !== null || undefined}>{busy === "add" ? COPY.passkeyAddBusy : COPY.passkeyAdd}</Button>
            </form>
          ) : <p>{where === "elsewhere" ? passkeysAddedOnlyAt(portalOrigin) : COPY.passkeysUnsupported}</p>}
        </div>
      )}
    </div>
  );
}
