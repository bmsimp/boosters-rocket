import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { familyCreditDetail, type StaffCreditLine } from "@/lib/volunteer/staff-credit";
import { amountWords } from "@/lib/volunteer/rules";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { TextAction } from "../../../seasons/forms";
import { OutsideCreditForm } from "../../forms";
import { addOutsideCreditAction, removeCreditAction } from "../actions";

export const metadata = { title: "Family volunteer credit" };
export const dynamic = "force-dynamic";

type Remove = (reason: string) => Promise<{ ok: true; message: string } | { ok: false; errors: string[] }>;

/**
 * The family's credit as a table: what each credit is, who it is for, how much, when and by whom, and where the rule
 * spends it (or, for removed credit, when and why it was removed). Notes and reasons are for staff only; text only.
 */
function CreditTable({ caption, credits, remove }: { caption: string; credits: StaffCreditLine[]; remove?: (id: string) => Remove }) {
  const columns: Column<StaffCreditLine>[] = [
    { key: "what", header: "Credit", rowHeader: true, cell: (c) => `${c.label}: ${c.what}` },
    { key: "who", header: "For", cell: (c) => c.who },
    { key: "amount", header: "Amount", cell: (c) => c.amount },
    { key: "at", header: "Recorded", cell: (c) => <><LocalTime iso={c.at} /> by {c.by}</> },
    { key: "counts", header: credits.some((c) => c.removed) ? "Removed" : "Counts as", cell: (c) => (
      <>
        {c.removed ? <span className="t-line">Removed <LocalTime iso={c.removed.at} /> by {c.removed.by}. Reason (staff only): {c.removed.reason}</span>
          : <span className="t-line">{c.spent.length === 0 ? "Counts toward nothing the club asks now." : `Counts as ${c.spent.join("; ")}.`}</span>}
        {c.note && <span className="t-line">Note (staff only): {c.note}</span>}
      </>) },
    ...(remove ? [{ key: "do", header: "What you can do", quiet: true, cell: (c: StaffCreditLine) => (
      <details className="more"><summary>Remove this credit</summary>
        <TextAction field="Why it's being removed (only staff see this)" label="Remove it" pendingLabel="Removing…" maxLength={500} multiline act={remove(c.id)} />
      </details>) }] : []),
  ];
  return <DataTable caption={caption} captionHidden columns={columns} rows={credits} rowKey={(c) => c.id} />;
}

/**
 * One family's volunteer credit (v1 spec §11.4): how it counts toward each volunteer requirement of the current
 * season, each credit with where it is spent, the credit staff removed with why, and a form to credit volunteering done
 * outside the portal. The family in the address is untrusted: one the roster doesn't show answers 404. Opening it is
 * audited, before anything is shown, as a read of one family's data. Notes and reasons are for staff only.
 */
export default async function FamilyCreditPage({ params }: { params: Promise<{ familyId: string }> }) {
  const ctx = await requireStaffPage("Volunteer.Credit.ReadWrite");
  const { familyId } = await params;
  // Read before the roster: a change of company in between makes the tag the older one, and a write is refused.
  const rosterTag = await currentRosterTag();
  const detail = familyId.length <= 64 ? await familyCreditDetail(familyId, rosterTag,
    { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: "Volunteer.Credit.ReadWrite" }) : null;
  if (!detail) notFound();
  const { family } = detail;
  const options = detail.requirements.map((r) => ({ id: r.id, unit: r.unit, appliesTo: r.appliesTo,
    label: `${r.title} (${r.amount === null ? "no amount set" : amountWords(r.unit, r.amount)}, ${r.appliesTo === "family" ? "the family" : "each student"})` }));
  return (
    <main className="wrap single">
      <h1 className="page-title">{family.name}</h1>
      <p className="lede">Volunteer credit. <Link href="/staff/volunteer/credit">All families</Link></p>

      <section className="box" aria-labelledby="asks-h"><h2 id="asks-h">What the club asks this season</h2>
        {detail.requirements.length === 0 ? <Notice tone="info" live="none">The current season asks no volunteering of this family.</Notice> : (
          <DataTable caption="Each volunteering requirement, and where the family stands" captionHidden rows={detail.requirements} rowKey={(r) => r.id} columns={[
            { key: "title", header: "Requirement", rowHeader: true, cell: (r) => `${r.title}${r.required ? "" : " (optional)"}` },
            { key: "due", header: "Due", cell: (r) => (r.dueOn ? <CalendarDate iso={r.dueOn} /> : "No due date") },
            { key: "stands", header: "Where it stands", cell: (r) => r.subjects.map((s) => (
              <span className="t-line" key={s.qboId}>{r.appliesTo === "student" ? `${s.who}: ` : ""}{s.waived ? "Waived" : s.words}</span>)) },
          ]} />
        )}
        <p className="hint">Credit fills required requirements before optional ones, a student&apos;s own before the family&apos;s, the soonest due first, and never beyond what each needs.</p>
      </section>

      <section className="box" aria-labelledby="credit-h"><h2 id="credit-h">Credit</h2>
        {detail.credits.length === 0 ? <Notice tone="info" live="none">No credit yet.</Notice>
          : <CreditTable caption="Each credit, and where it counts" credits={detail.credits} remove={(id) => removeCreditAction.bind(null, id, rosterTag)} />}
      </section>

      <section className="box" aria-labelledby="outside-h"><h2 id="outside-h">Credit volunteering done outside the portal</h2>
        <p>For help the club counts that wasn&apos;t a shift here. The family sees &ldquo;Added by the club&rdquo; and the amount; only staff see the note.</p>
        <OutsideCreditForm requirements={options} students={family.students.map((s) => ({ value: s.qboId, label: s.name }))} save={addOutsideCreditAction.bind(null, rosterTag, family.qboId)} />
      </section>

      {detail.removed.length > 0 && (
        <section className="box" aria-labelledby="removed-h"><h2 id="removed-h">Removed credit</h2>
          <CreditTable caption="Each credit removed, and why" credits={detail.removed} />
        </section>
      )}
    </main>
  );
}
