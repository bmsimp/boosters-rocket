import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { loadRequest } from "@/lib/signed-forms/evidence";
import { CELL_WORDS, RESTART_REASONS, cellState, cellTone } from "@/lib/signed-forms/rules";
import { LocalTime } from "../../../../../components/local-time";
import { StateWords } from "../../../../../components/state-words";
import { DataTable } from "../../../../../components/data-table";
import { Notice } from "../../../../../components/notice";
import { remindRequestAction, startAgainAction } from "../../actions";
import { RemindButton, StartAgainForm } from "../../forms";

export const metadata = { title: "Form" };
export const dynamic = "force-dynamic";

/**
 * One family's or student's form, as it stands: who it was made for, who has signed, the consents, and what staff can
 * do about it (remind, start again). A staff read of one family's data: audited (forms.request.read) before anything
 * is shown. The id in the address is checked before it is looked up.
 */
export default async function FormRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Forms.Signature.Read");
  const { id } = await params;
  const view = await loadRequest(id);
  if (!view) notFound();
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "forms.request.read", permission: "Forms.Signature.Read",
    targetType: "signature_request", targetId: view.row.id, ip: ctx.ip, after: { familyQboId: view.row.familyQboId, subjectQboId: view.row.subjectQboId } });
  const { row } = view;
  const state = cellState({ covered: true, waived: false, request: row });
  const writes = can(ctx.effective, "Forms.Signature.ReadWrite");
  const open = row.state !== "complete";
  const restartable = open && row.envelopeId !== null;
  return (
    <main className="wrap single">
      <h1 className="page-title">{view.title}</h1>
      <p className="lede">For {view.appliesTo === "family" ? `the family, ${view.familyName ?? row.familyQboId}` : `${view.subjectName ?? row.subjectQboId}, of ${view.familyName ?? row.familyQboId}`}. <Link href="/staff/forms">Back to signed forms</Link></p>

      <section className="box" aria-labelledby="state-h">
        <h2 id="state-h">Where it stands</h2>
        <StateWords state={cellTone(state)} words={CELL_WORDS[state]} />
        <p className="help">{view.signersMode === "every" ? "Every guardian with a sign-in signs it, up to the template's signers." : "Any one guardian signs it."}</p>
        {view.evidenceId && <p><Link className="link-line" href={`/staff/forms/evidence/${view.evidenceId}`}>Open the signed form and its evidence</Link></p>}
        {row.state === "complete" && !view.evidenceId && <Notice tone="info" live="none">Signed and sealed. The signed copy is being fetched from Documenso and filed; its evidence will be here soon.</Notice>}
        {row.signers.length > 0 && (
          <DataTable caption="Each guardian who signs it, and whether they have" captionHidden rows={row.signers} rowKey={(s) => String(s.recipientId)} columns={[
            { key: "name", header: "Guardian", rowHeader: true, cell: (s) => s.name },
            { key: "email", header: "Email", cell: (s) => s.email },
            { key: "signed", header: "Signed", cell: (s) => (s.signedAt ? <LocalTime iso={s.signedAt} /> : "Hasn't signed yet") },
          ]} />
        )}
        {row.evidenceError && row.evidenceOwed && <Notice tone="warning" live="none">The last try at fetching the signed copy failed ({row.evidenceError}). The worker tries again{row.evidenceNextAt ? <> after <LocalTime iso={row.evidenceNextAt.toISOString()} /></> : " soon"}.</Notice>}
      </section>

      <section className="box" aria-labelledby="consent-h">
        <h2 id="consent-h">Consent to sign electronically</h2>
        {view.consents.length === 0 ? <p>No guardian has agreed yet.</p> : (
          <DataTable caption="Each guardian's consent to sign electronically" captionHidden rows={view.consents.map((c, i) => ({ ...c, key: String(i) }))} rowKey={(c) => c.key} columns={[
            { key: "name", header: "Guardian", rowHeader: true, cell: (c) => c.parentName },
            { key: "text", header: "Consent text", cell: (c) => `Text of ${c.textVersion}` },
            { key: "at", header: "Agreed", cell: (c) => <LocalTime iso={c.agreedAt.toISOString()} /> },
          ]} />
        )}
      </section>

      {writes && open && (
        <section className="box" aria-labelledby="remind-h">
          <h2 id="remind-h">Remind</h2>
          <p>Emails the guardians who still have to sign it, with a link to the form. Nobody is reminded about one form more than once a day.</p>
          <RemindButton label="Remind now" run={remindRequestAction.bind(null, row.id)} />
        </section>
      )}

      {writes && restartable && (
        <section className="box" aria-labelledby="restart-h">
          <h2 id="restart-h">Start again</h2>
          <p>For a form that was declined, that everyone signed more than six hours ago and still isn&apos;t sealed, whose document Documenso no longer has, or that a guardian who must sign can no longer reach.</p>
          <StartAgainForm reasons={Object.entries(RESTART_REASONS).map(([value, label]) => ({ value, label }))} run={startAgainAction.bind(null, row.id)} />
        </section>
      )}
    </main>
  );
}
