import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { RECORD_KEY, loadEvidence } from "@/lib/signed-forms/evidence";
import { LocalTime } from "../../../../../components/local-time";

export const metadata = { title: "Signed form" };
export const dynamic = "force-dynamic";

const sizeWords = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

/**
 * One signed form's evidence (v1 spec §9.4): who signed and when, the consents, the template and its last-changed time,
 * the hashes, and a download of each kept file. A staff read of one family's signed form: audited
 * (forms.evidence.read) before anything is shown. Evidence from an earlier QuickBooks company opens here too, from the
 * archive, by the names it kept.
 */
export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Forms.Signature.Read");
  const { id } = await params;
  const view = await loadEvidence(id);
  if (!view) notFound();
  const e = view.evidence;
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "forms.evidence.read", permission: "Forms.Signature.Read",
    targetType: "signed_form_evidence", targetId: e.id, ip: ctx.ip, after: { requestId: e.requestId, familyQboId: e.familyQboId, earlierCompany: view.earlier } });
  const download = (key: string) => `/staff/forms/evidence/${e.id}/${key}`;
  return (
    <main className="wrap single">
      <h1 className="page-title">{e.formTitle}</h1>
      <p className="lede">Signed for {e.subjectName ?? e.subjectQboId}{e.familyName && e.subjectKind === "student" ? `, of ${e.familyName}` : ""}{e.seasonName ? ` · ${e.seasonName}` : ""}. <Link href="/staff/forms">Back to signed forms</Link></p>
      {view.earlier && <p role="status" className="box">This form was signed under a QuickBooks company that is no longer connected. It is kept as the club&apos;s record, by the names it had then; families don&apos;t see it.</p>}
      {e.mismatchAt && <p role="alert" className="box">A later fetch from Documenso gave one of these files a different hash, on <LocalTime iso={e.mismatchAt.toISOString()} />. The first copy is the one kept here.</p>}

      <section className="box" aria-labelledby="files-h">
        <h2 id="files-h">Download</h2>
        <ul className="lines">
          {view.files.map((f) => (
            <li key={f.id}><div><a className="what" href={download(f.key)} download>{f.label}</a><span className="when hash">SHA-256 {f.sha256}</span></div><span className="num">{sizeWords(f.size)}</span></li>
          ))}
          <li><div><a className="what" href={download(RECORD_KEY)} download>The evidence record (JSON)</a><span className="when">Everything on this page, with each file&apos;s size and hash</span></div></li>
        </ul>
      </section>

      <section className="box" aria-labelledby="signers-h">
        <h2 id="signers-h">Who signed</h2>
        <ul className="lines">{e.signers.map((s, i) => (
          <li key={i}><div><span className="what">{s.name}</span><span className="when">{s.email}</span></div><span>{s.signedAt ? <>Signed <LocalTime iso={s.signedAt} /></> : "Not signed"}</span></li>))}</ul>
        {e.completedAt && <p className="help">Sealed by Documenso <LocalTime iso={e.completedAt.toISOString()} />. Kept here <LocalTime iso={e.storedAt.toISOString()} />.</p>}
      </section>

      <section className="box" aria-labelledby="consents-h">
        <h2 id="consents-h">Consent to sign electronically</h2>
        {e.consents.length === 0 ? <p>No consent was recorded with this form.</p> : (
          <ul className="lines">{e.consents.map((c, i) => (
            <li key={i}><div><span className="what">{c.name}</span><span className="when">{c.email} · text of {c.textVersion}{c.ip ? ` · from ${c.ip}` : ""}</span></div><span><LocalTime iso={c.agreedAt} /></span></li>))}</ul>
        )}
      </section>

      <section className="box" aria-labelledby="doc-h">
        <h2 id="doc-h">The document in Documenso</h2>
        <dl className="details">
          <dt>Document</dt><dd className="hash">{e.envelopeId}</dd>
          <dt>Template</dt><dd className="hash">{e.templateId ?? "Not recorded"}</dd>
          <dt>Template last changed</dt><dd>{e.templateUpdatedAt ? <LocalTime iso={e.templateUpdatedAt.toISOString()} /> : "Not recorded"}</dd>
          {e.originals.map((o, i) => <Fragment key={o.itemId}><dt>Original PDF{e.originals.length > 1 ? `, part ${i + 1}` : ""}</dt><dd className="hash">SHA-256 {o.sha256}</dd></Fragment>)}
        </dl>
      </section>

      <section className="box" aria-labelledby="copies-h">
        <h2 id="copies-h">Copies to guardians</h2>
        {view.copies.length === 0 ? <p>{e.copiesDoneAt ? "No copy was sent." : "Not sent yet."}</p> : (
          <ul className="lines">{view.copies.map((c, i) => {
            const who = e.signers.find((s) => s.parentId === c.parentId)?.name ?? "A guardian";
            const words = c.outcome === "sent" ? (c.how === "attached" ? "Emailed, with the signed form attached" : "Emailed, with a link to download it")
              : c.outcome === "failed" ? "Couldn't be emailed" : c.outcome === "skipped" ? "Not sent: their access was closed" : "Being sent";
            return <li key={i}><div><span className="what">{who}</span><span className="when">{words}</span></div><span>{c.doneAt ? <LocalTime iso={c.doneAt.toISOString()} /> : ""}</span></li>;
          })}</ul>
        )}
      </section>
    </main>
  );
}
