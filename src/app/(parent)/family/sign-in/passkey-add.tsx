"use client";
import type { Ref } from "react";
import { parentAuthClient } from "@/lib/auth/client";
import { readCeremony, type CeremonyOutcome } from "@/app/sign-in/passkey-ceremony";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { CopyButton } from "./authenticator-box";
import { toPortalAdd } from "./passkey-adding";

/**
 * Adding a passkey in the browser, shared by the Passkeys box on Sign-in settings (PasskeyBox, the sign-in release's
 * slice SI-7b) and the passkey offer on Home (PasskeyOffer, slice SI-8): the library's ceremony with its verify request
 * sent to the portal's /portal-passkey/add (toPortalAdd()), the outcome read in words, and the backup codes a first
 * passkey makes, shown once.
 */

/** What the portal's add answers (addMyPasskey(), src/lib/parents/passkey-settings.ts). */
type AddAnswer = { ok: true; codes?: string[] } | { ok: false; error: "rejected" | "rate_limited" | "prove_again" | "already_added" };
/** The add's outcome: the passkey added (with a first passkey's backup codes when it made them), or the words of why not. */
export type AddOutcome = { ok: true; codes?: string[] } | { ok: false; error: string };

export const Tick = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>;

/**
 * What the library's browser ceremony answers when the browser or password manager refused to make the passkey because
 * it holds one of the person's already (the options list them in `excludeCredentials`): @simplewebauthn/browser's
 * InvalidStateError, which @better-auth/passkey/client returns as this code. readCeremony() (SI-7a's) reads every
 * `ERROR_` code as a cancel, so the add looks for this one first.
 */
const HELD_ALREADY = "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED";
const heldAlready = (r: unknown) => typeof r === "object" && r !== null && (r as { error?: { code?: unknown } | null }).error?.code === HELD_ALREADY;

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
 * Runs the add on this page's origin, with the name typed ("" for none: the row is drawn "Passkey added" and its date
 * on Sign-in settings, where it can be renamed). Never throws.
 */
export async function addPasskeyHere(name: string): Promise<AddOutcome> {
  let outcome: CeremonyOutcome<AddAnswer>;
  try {
    const r = await parentAuthClient.passkey.addPasskey(undefined, toPortalAdd(window.location.origin, name));
    if (heldAlready(r)) return { ok: false, error: COPY.passkeyAlreadyHeld };
    outcome = readCeremony<AddAnswer>(r);
  } catch {
    outcome = { kind: "failed", status: null };
  }
  if (outcome.kind === "answer" && outcome.body.ok) return outcome.body.codes ? { ok: true, codes: outcome.body.codes } : { ok: true };
  return { ok: false, error: addRefusal(outcome) };
}

/**
 * Backup codes shown once: the line that says so (a status, focusable, which the caller focuses), the heading, the
 * words of how to keep them (beside an app, or in place of a passkey), the list and its copy button.
 */
export function BackupCodesShown({ message, list, app, lineRef }: { message: string; list: string[]; app: boolean; lineRef: Ref<HTMLParagraphElement> }) {
  return (
    <div className="stack">
      <p ref={lineRef} role="status" tabIndex={-1} className="paid-up"><Tick />{message}</p>
      <h3>{COPY.backupCodesTitle}</h3>
      <p>{app ? COPY.backupCodesKeep : COPY.backupCodesKeepPasskey}</p>
      <ul className="backup-codes" aria-label={COPY.backupCodesTitle}>
        {list.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <CopyButton text={list.join("\n")} label={COPY.copyCodes} />
    </div>
  );
}
