"use client";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { CalendarDate } from "@/app/components/calendar-date";
import type { SaveOutcome } from "@/lib/auth/provider-fields";
import type { SummaryView } from "./labels";

export type CertificateActions = { replace: () => Promise<SaveOutcome>; discard: () => Promise<SaveOutcome> };

/** A one-button form for a certificate action (a POST server action), with its own error line. */
function ActionButton({ label, busy, action, confirmText }: { label: string; busy: string; action: () => Promise<SaveOutcome>; confirmText?: string }) {
  const [state, run, pending] = useActionState(async () => safely(action, { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={run} onSubmit={confirmText ? (e) => { if (!confirm(confirmText)) e.preventDefault(); } : undefined}>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <button className="btn btn-line" disabled={pending}>{pending ? busy : label}</button>
    </form>
  );
}

/**
 * The certificate Microsoft needs on the app registration: download it, then upload it in Entra (or let the script add it).
 * **Replace certificate** makes a new pending certificate (the download then serves it); **Discard replacement** drops it.
 */
export function CertificatePanel({ fileName, summary, actions }: { fileName: string; summary: SummaryView | null; actions?: CertificateActions }) {
  const router = useRouter();
  const active = summary?.certificate ?? null;
  const pending = summary?.pendingCertificate ?? null;
  const pendingReadable = Boolean(summary?.pendingReadable);
  const activeReadable = Boolean(active && summary?.readable);
  const shown = pending ?? active;
  // Replace when there's a certificate but no pending one this server can use: the routine replacement, and recovery
  // when a key can't be decrypted (for example after SETTINGS_ENCRYPTION_KEY changed and setup was reopened).
  const canReplace = Boolean(actions && shown && !pendingReadable);
  const canDiscard = Boolean(actions && pending && active);
  return (
    <div className="stack cert-panel">
      {active && <p className="hint">In use: thumbprint <code>{active.thumbprintSha1}</code>, expires <CalendarDate iso={active.notAfter} />.
        {!activeReadable && " This server can't read its key with the current encryption key, so it can't be used to sign in. Replace it."}</p>}
      {pending && (pendingReadable
        ? <p className="hint">{active ? "Replacement" : "Certificate"} ready to add to the app: Thumbprint <code>{pending.thumbprintSha1}</code>, expires <CalendarDate iso={pending.notAfter} />. {active ? "The one in use keeps working until the new one checks out." : ""}</p>
        : <p className="hint">The {active ? "replacement " : ""}certificate waiting to be added (thumbprint <code>{pending.thumbprintSha1}</code>) can&apos;t be read with this server&apos;s encryption key. Replace it with a new one.</p>)}
      {!shown && <p className="hint">Booster Rocket makes the certificate when you download it. Only the public half leaves the server.</p>}
      <p><a className="btn btn-line" href={`/setup/certificates/${fileName}`} download onClick={() => setTimeout(() => router.refresh(), 1500)}>Download certificate (.cer)</a></p>
      {canReplace && <ActionButton label="Replace certificate" busy="Making a new certificate…" action={actions!.replace} />}
      {canDiscard && <ActionButton label="Discard replacement" busy="Discarding…" action={actions!.discard}
        confirmText="Discard the replacement certificate? If you already added it to the app registration, remove it there too." />}
    </div>
  );
}
