import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { familyCreditDetail, type StaffCreditLine } from "@/lib/volunteer/staff-credit";
import { amountWords } from "@/lib/volunteer/rules";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { TextAction } from "../../../seasons/forms";
import { OutsideCreditForm } from "../../forms";
import { addOutsideCreditAction, removeCreditAction } from "../actions";

export const metadata = { title: "Family volunteer credit" };
export const dynamic = "force-dynamic";

function CreditItem({ c, remove }: { c: StaffCreditLine; remove?: (reason: string) => Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> }) {
  return (
    <li><div>
      <span className="what">{c.label}: {c.what}</span>
      <span className="when">{c.who} · {c.amount} · <LocalTime iso={c.at} /> · by {c.by}</span>
      {c.note && <span className="when">Note (staff only): {c.note}</span>}
      {!c.removed && <span className="when">{c.spent.length === 0 ? "Counts toward nothing the club asks now." : `Counts as ${c.spent.join("; ")}.`}</span>}
      {c.removed && <span className="when">Removed <LocalTime iso={c.removed.at} /> by {c.removed.by}. Reason (staff only): {c.removed.reason}</span>}
      {remove && (
        <details className="more"><summary>Remove this credit</summary>
          <TextAction field="Why it's being removed (only staff see this)" label="Remove it" pendingLabel="Removing…" maxLength={500} multiline act={remove} />
        </details>
      )}
    </div></li>
  );
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
        {detail.requirements.length === 0 ? <p>The current season asks no volunteering of this family.</p> : (
          <ul className="lines">{detail.requirements.map((r) => (
            <li key={r.id}><div>
              <span className="what">{r.title}{r.required ? "" : " (optional)"}</span>
              {r.dueOn && <span className="when">Due <CalendarDate iso={r.dueOn} /></span>}
              {r.subjects.map((s) => <span className="when" key={s.qboId}>{r.appliesTo === "student" ? `${s.who}: ` : ""}{s.waived ? "Waived" : s.words}</span>)}
            </div></li>))}</ul>
        )}
        <p className="hint">Credit fills required requirements before optional ones, a student&apos;s own before the family&apos;s, the soonest due first, and never beyond what each needs.</p>
      </section>

      <section className="box" aria-labelledby="credit-h"><h2 id="credit-h">Credit</h2>
        {detail.credits.length === 0 ? <p>No credit yet.</p> : (
          <ul className="lines">{detail.credits.map((c) => <CreditItem key={c.id} c={c} remove={removeCreditAction.bind(null, c.id, rosterTag)} />)}</ul>
        )}
      </section>

      <section className="box" aria-labelledby="outside-h"><h2 id="outside-h">Credit volunteering done outside the portal</h2>
        <p>For help the club counts that wasn&apos;t a shift here. The family sees &ldquo;Added by the club&rdquo; and the amount; only staff see the note.</p>
        <OutsideCreditForm requirements={options} students={family.students.map((s) => ({ value: s.qboId, label: s.name }))} save={addOutsideCreditAction.bind(null, rosterTag, family.qboId)} />
      </section>

      {detail.removed.length > 0 && (
        <section className="box" aria-labelledby="removed-h"><h2 id="removed-h">Removed credit</h2>
          <ul className="lines">{detail.removed.map((c) => <CreditItem key={c.id} c={c} />)}</ul>
        </section>
      )}
    </main>
  );
}
