import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { RECORD_KEY, loadEvidence } from "@/lib/signed-forms/evidence";
import { recordNameWords } from "@/lib/families/words";
import { LocalTime } from "../../../../../components/local-time";
import { DataTable } from "../../../../../components/data-table";
import { Notice } from "../../../../../components/notice";

export const metadata = { title: "Signed form" };
export const dynamic = "force-dynamic";

const sizeWords = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

/**
 * One signed form's evidence (v1 spec §9.4): who signed and when, the consents, the template and its last-changed time,
 * the hashes, and a download of each kept file. A staff read of one family's signed form: audited
 * (forms.evidence.read) before anything is shown. Evidence kept with no QuickBooks company (a family with no link) is
 * current, and shows no QuickBooks number. Evidence from an earlier QuickBooks company opens here too, from the
 * archive, by the names it kept.
 */
export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Forms.Signature.Read");
  const { id } = await params;
  const view = await loadEvidence(id);
  if (!view) notFound();
  const e = view.evidence;
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "forms.evidence.read", permission: "Forms.Signature.Read",
    targetType: "signed_form_evidence", targetId: e.id, ip: ctx.ip, after: { requestId: e.requestId, familyId: e.familyId === null ? null : String(e.familyId), studentId: e.studentId === null ? null : String(e.studentId), earlierCompany: view.earlier } });
  const download = (key: string) => `/staff/forms/evidence/${e.id}/${key}`;
  return (
    <main className="wrap single">
      <h1 className="page-title">{e.formTitle}</h1>
      <p className="lede">Signed for {e.subjectName ?? e.subjectQboId ?? recordNameWords(null, e.subjectKind)}{e.familyName && e.subjectKind === "student" ? `, of ${e.familyName}` : ""}{e.seasonName ? ` · ${e.seasonName}` : ""}. <Link href="/staff/forms">Back to signed forms</Link></p>
      {view.earlier && <Notice tone="info">This form was signed under a QuickBooks company that is no longer connected. It is kept as the club&apos;s record, by the names it had then; families don&apos;t see it.</Notice>}
      {e.mismatchAt && <Notice tone="warning" live="alert">A later fetch from Documenso gave one of these files a different hash, on <LocalTime iso={e.mismatchAt.toISOString()} />. The first copy is the one kept here.</Notice>}

      <section className="box" aria-labelledby="files-h">
        <h2 id="files-h">Download</h2>
        <DataTable caption="Each kept file, with its hash and size" captionHidden rowKey={(f) => f.key}
          rows={[...view.files.map((f) => ({ key: f.key, label: f.label, hash: `SHA-256 ${f.sha256}`, size: sizeWords(f.size) })),
            { key: RECORD_KEY, label: "The evidence record (JSON)", hash: "Everything on this page, with each file's size and hash", size: "" }]}
          columns={[
            // Plain links, not Links: each is a file, and every download is audited, so none may be fetched ahead of a click.
            { key: "file", header: "File", rowHeader: true, cell: (f) => <a href={download(f.key)} download>{f.label}</a> },
            { key: "hash", header: "Hash", cell: (f) => <span className="hash">{f.hash}</span> },
            { key: "size", header: "Size", numeric: true, cell: (f) => f.size },
          ]} />
      </section>

      <section className="box" aria-labelledby="signers-h">
        <h2 id="signers-h">Who signed</h2>
        <DataTable caption="Who signed, and when" captionHidden rows={e.signers.map((s, i) => ({ ...s, key: String(i) }))} rowKey={(s) => s.key} columns={[
          { key: "name", header: "Guardian", rowHeader: true, cell: (s) => s.name },
          { key: "email", header: "Email", cell: (s) => s.email },
          { key: "signed", header: "Signed", cell: (s) => (s.signedAt ? <LocalTime iso={s.signedAt} /> : "Not signed") },
        ]} />
        {e.completedAt && <p className="help">Sealed by Documenso <LocalTime iso={e.completedAt.toISOString()} />. Kept here <LocalTime iso={e.storedAt.toISOString()} />.</p>}
      </section>

      <section className="box" aria-labelledby="consents-h">
        <h2 id="consents-h">Consent to sign electronically</h2>
        {e.consents.length === 0 ? <p>No consent was recorded with this form.</p> : (
          <DataTable caption="Each guardian's consent to sign electronically" captionHidden rows={e.consents.map((c, i) => ({ ...c, key: String(i) }))} rowKey={(c) => c.key} columns={[
            { key: "name", header: "Guardian", rowHeader: true, cell: (c) => c.name },
            { key: "email", header: "Email", cell: (c) => c.email },
            { key: "text", header: "Consent text", cell: (c) => <>Text of {c.textVersion}{c.ip ? <span className="when">From {c.ip}</span> : null}</> },
            { key: "at", header: "Agreed", cell: (c) => <LocalTime iso={c.agreedAt} /> },
          ]} />
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
          <DataTable caption="The copy each guardian who signed was sent" captionHidden rows={view.copies.map((c, i) => ({ ...c, key: String(i) }))} rowKey={(c) => c.key} columns={[
            { key: "who", header: "Guardian", rowHeader: true, cell: (c) => e.signers.find((s) => s.parentId === c.parentId)?.name ?? "A guardian" },
            { key: "what", header: "Copy", cell: (c) => (c.outcome === "sent" ? (c.how === "attached" ? "Emailed, with the signed form attached" : "Emailed, with a link to download it")
              : c.outcome === "failed" ? "Couldn't be emailed" : c.outcome === "skipped" ? "Not sent: their access was closed" : "Being sent") },
            { key: "at", header: "When", cell: (c) => (c.doneAt ? <LocalTime iso={c.doneAt.toISOString()} /> : "Not yet") },
          ]} />
        )}
      </section>
    </main>
  );
}
