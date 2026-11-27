"use client";
import { useState, type ReactNode, type Ref } from "react";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { Button, Field } from "@/app/components/ui";

/** A press that copies `text`, and only it, saying in words whether it did. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState("copied"); } catch { setState("failed"); }
  };
  return (
    <div className="stack">
      <Button variant="outlined" onClick={() => void copy()}>{label}</Button>
      <p role="status" className="help">{state === "copied" ? COPY.copied : state === "failed" ? COPY.copyFailed : ""}</p>
    </div>
  );
}

/** The set-up's first answer as the page holds it: the key to type (in fours) and the QR code's squares, drawn on the server. */
export type AppSetupShown = { key: string; qr: { size: number; path: string } };

/**
 * An authenticator app being set up (slice SI-6b's words and parts), shared by the Authenticator app box on Sign-in
 * settings (AuthenticatorBox) and Strict's enrolment (/one-more-step, slice SI-10a): the QR code drawn from the squares
 * the press answered, the key to type with its copy press, and the code that finishes it. Given only what it shows and
 * what its form does; the caller holds the set-up in its own state, and says how long it lasts (`lost`).
 */
export function AppSetupForm({ setup, code, onCode, onConfirm, busy, answered, landing, lost }: { setup: AppSetupShown; code: string;
  onCode: (code: string) => void; onConfirm: () => void; busy: boolean; answered: ReactNode; landing: Ref<HTMLParagraphElement>; lost: string }) {
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
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onConfirm(); }}>
        <p id="app-confirm-lede">{COPY.appConfirmLede}</p>
        {/* The field is described by the line above it, which says what to enter. */}
        <Field id="app-confirm-code" label={COPY.appConfirmCode}>
          {(aria) => <input {...aria} name="code" aria-describedby="app-confirm-lede" inputMode="numeric" autoComplete="one-time-code" maxLength={20} required
            value={code} onChange={(e) => onCode(e.target.value)} />}
        </Field>
        {answered}
        {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
        <Button type="submit" busy={busy}>{busy ? COPY.checking : COPY.appConfirm}</Button>
      </form>
      <p className="help">{lost}</p>
    </div>
  );
}
