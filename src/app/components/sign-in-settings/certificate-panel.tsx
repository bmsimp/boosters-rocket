"use client";
import { useRouter } from "next/navigation";
import { CalendarDate } from "@/app/components/calendar-date";
import type { SummaryView } from "./labels";

/** The certificate Microsoft needs on the app registration: download it, then upload it in Entra (or let the script add it). */
export function CertificatePanel({ fileName, summary, settings }: { fileName: string; summary: SummaryView | null; settings: boolean }) {
  const router = useRouter();
  const active = summary?.certificate ?? null;
  const pending = summary?.pendingCertificate ?? null;
  const shown = pending ?? active;
  const replacing = Boolean(active && !pending && settings);
  const label = replacing ? "Replace certificate (download a new .cer)" : "Download certificate (.cer)";
  const href = `/setup/certificates/${fileName}${replacing ? "?replace=1" : ""}`;
  return (
    <div className="stack cert-panel">
      {active && <p className="hint">In use: thumbprint <code>{active.thumbprintSha1}</code>, expires <CalendarDate iso={active.notAfter} />.</p>}
      {pending && <p className="hint">{active ? "Replacement" : "Certificate"} ready to add to the app: Thumbprint <code>{pending.thumbprintSha1}</code>, expires <CalendarDate iso={pending.notAfter} />. {active ? "The one in use keeps working until the new one checks out." : ""}</p>}
      {!shown && <p className="hint">Booster Rocket makes the certificate when you download it. Only the public half leaves the server.</p>}
      <p><a className="btn btn-line" href={href} download onClick={() => setTimeout(() => router.refresh(), 1500)}>{label}</a></p>
    </div>
  );
}
