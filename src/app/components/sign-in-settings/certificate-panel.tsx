"use client";
import { useActionState, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { CalendarDate } from "@/app/components/calendar-date";
import { StateWords } from "@/app/components/state-words";
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
 * Download certificate. The server makes the certificate on the first download, so the page is read again once the
 * download has finished, not after a guess at how long it takes: the file is fetched here, handed to the browser to
 * save, and only then is the page refreshed to show its thumbprint. Without script the link downloads as a link does.
 */
function DownloadLink({ fileName }: { fileName: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const href = `/setup/certificates/${fileName}`;
  const download = async (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setFailed(false);
    try {
      const res = await fetch(href, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setFailed(true); }
    router.refresh();
  };
  return (
    <>
      <p><a className="btn btn-line" href={href} download onClick={download}>Download certificate (.cer)</a></p>
      {failed && <p role="alert" className="errors">The certificate didn&apos;t download. Reload the page and try again.</p>}
    </>
  );
}

/**
 * The certificate Microsoft needs on the app registration: download it, then upload it in Entra (or let the script add it).
 * Once one is in use and nothing waits to replace it, the panel says it is done, and Download and Replace are tucked
 * under Manage certificate: there is nothing left to do by hand. **Replace certificate** makes a new pending certificate
 * (the download then serves it); **Discard replacement** drops it.
 */
export function CertificatePanel({ fileName, summary, actions }: { fileName: string; summary: SummaryView | null; actions?: CertificateActions }) {
  const active = summary?.certificate ?? null;
  const pending = summary?.pendingCertificate ?? null;
  const pendingReadable = Boolean(summary?.pendingReadable);
  const activeReadable = Boolean(active && summary?.readable);
  const shown = pending ?? active;
  // Replace when there's a certificate but no pending one this server can use: the routine replacement, and recovery
  // when a key can't be decrypted (for example after SETTINGS_ENCRYPTION_KEY changed and setup was reopened).
  const canReplace = Boolean(actions && shown && !pendingReadable);
  const canDiscard = Boolean(actions && pending && active);
  const replace = canReplace && <ActionButton label="Replace certificate" busy="Making a new certificate…" action={actions!.replace} />;
  if (active && activeReadable && !pending) {
    return (
      <div className="stack cert-panel">
        <p className="cert-done"><StateWords state="done" words="Done: Microsoft accepted this certificate" /></p>
        <p className="hint">Thumbprint <code>{active.thumbprintSha1}</code>, expires <CalendarDate iso={active.notAfter} />. Nothing more to do until it nears its expiry.</p>
        <details className="more"><summary>Manage certificate</summary>
          <div className="stack">
            <p className="hint">Download it again to add it to another app registration by hand. Replace it before it expires: the one in use keeps working until the new one checks out.</p>
            <DownloadLink fileName={fileName} />
            {replace}
          </div>
        </details>
      </div>
    );
  }
  return (
    <div className="stack cert-panel">
      {active && <p className="hint">In use: thumbprint <code>{active.thumbprintSha1}</code>, expires <CalendarDate iso={active.notAfter} />.
        {!activeReadable && " This server can't read its key with the current encryption key, so it can't be used to sign in. Replace it."}</p>}
      {pending && (pendingReadable
        ? <p className="hint">{active ? "Replacement" : "Certificate"} ready to add to the app: Thumbprint <code>{pending.thumbprintSha1}</code>, expires <CalendarDate iso={pending.notAfter} />. {active ? "The one in use keeps working until the new one checks out." : ""}</p>
        : <p className="hint">The {active ? "replacement " : ""}certificate waiting to be added (thumbprint <code>{pending.thumbprintSha1}</code>) can&apos;t be read with this server&apos;s encryption key. Replace it with a new one.</p>)}
      {!shown && <p className="hint">Booster Rocket makes the certificate when you download it. Only the public half leaves the server.</p>}
      <DownloadLink fileName={fileName} />
      {replace}
      {canDiscard && <ActionButton label="Discard replacement" busy="Discarding…" action={actions!.discard}
        confirmText="Discard the replacement certificate? If you already added it to the app registration, remove it there too." />}
    </div>
  );
}
