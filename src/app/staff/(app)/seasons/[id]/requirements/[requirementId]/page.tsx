import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { describeRequirement, getRequirementSetup } from "@/lib/seasons/setup";
import { candidatesFor, loadSubjects } from "@/lib/seasons/subjects";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { CalendarDate } from "@/app/components/calendar-date";
import { dateWords, shiftTimeWords } from "@/lib/volunteer/clock";
import { shiftsCountingToward } from "@/lib/volunteer/setup";
import { CoverageForm, OneButton, RequirementForm } from "../../../forms";
import { removeRequirementAction, setCoverageAction, updateRequirementAction } from "../../../actions";

export const metadata = { title: "Requirement" };
export const dynamic = "force-dynamic";

export default async function RequirementPage({ params }: { params: Promise<{ id: string; requirementId: string }> }) {
  const ctx = await requireStaffPage("Season.Steps.Read");
  const { id, requirementId } = await params;
  const found = isUuid(id) && isUuid(requirementId) ? await getRequirementSetup(requirementId) : null;
  // The address names the season too: a requirement asked for under another season isn't there.
  if (!found || found.season.id !== id) notFound();
  const { requirement: r, step, season, recorded } = found;
  const canChange = can(ctx.effective, "Season.Steps.ReadWrite");
  // The tag first: a change of company before the roster is read leaves it the older one, and the save is refused.
  const rosterTag = await currentRosterTag();
  const families = await loadSubjects();
  const candidates = families ? candidatesFor(r.appliesTo, families) : [];
  const onRoster = new Set(candidates.map((c) => c.qboId));
  const noun = r.appliesTo === "family" ? "families" : "students";
  const seesVolunteer = can(ctx.effective, "Volunteer.Event.Read");
  const shifts = r.kind === "volunteer" ? await shiftsCountingToward(r.id) : [];
  const back = `/staff/seasons/${season.id}`;
  return (
    <main className="wrap single">
      <h1 className="page-title">{r.title}</h1>
      <p className="lede">In {step.name}, {season.name}. <Link href={back}>Back to {season.name}</Link>
        {can(ctx.effective, "Season.Progress.Read") && <> · <Link href={`/staff/seasons/progress/${r.id}`}>Who has done it</Link></>}</p>

      <section className="box" aria-labelledby="req-h"><h2 id="req-h">Settings</h2>
        <p>{describeRequirement(r)}{r.dueOn ? <> · Due <CalendarDate iso={r.dueOn} /></> : null}</p>
        {canChange && (
          <>
            <p className="hint">The kind, and whether it is asked of each family or each student, are set when a requirement is added and stay as they are.</p>
            <RequirementForm kind={r.kind} initial={{ title: r.title, required: r.required, amount: r.amount, amountUnit: r.amountUnit, dueOn: r.dueOn }} save={updateRequirementAction.bind(null, r.id)} />
          </>
        )}
      </section>

      <section className="box" aria-labelledby="cover-h"><h2 id="cover-h">Who it is asked of</h2>
        <p>{r.covers === "everyone" ? `Everyone: every ${r.appliesTo === "family" ? "family" : "student"} on the roster.`
          : `A chosen list: ${r.coveredQboIds.filter((q) => onRoster.has(q)).length} of the ${noun} on the roster.`}</p>
        {r.covers === "chosen" && (
          <ul className="lines">{candidates.filter((c) => r.coveredQboIds.includes(c.qboId)).map((c) => (
            <li key={c.qboId}><div><span className="what">{c.name}</span>{r.appliesTo === "student" && <span className="when">{c.familyName}</span>}</div></li>))}</ul>
        )}
        {canChange && (families === null
          ? <p role="status">The roster can&apos;t be shown right now, so a list can&apos;t be chosen. Check QuickBooks under Roster.</p>
          : <details className="more"><summary>Change who it is asked of</summary>
              <CoverageForm covers={r.covers} chosen={r.coveredQboIds.filter((q) => onRoster.has(q))} noun={noun}
                candidates={candidates.map((c) => ({ qboId: c.qboId, label: r.appliesTo === "student" ? `${c.name} (${c.familyName})` : c.name }))}
                save={setCoverageAction.bind(null, r.id, rosterTag)} />
            </details>)}
      </section>

      {r.kind === "volunteer" && (
        <section className="box" aria-labelledby="shifts-h"><h2 id="shifts-h">Shifts that count toward it</h2>
          {shifts.length === 0 ? <p>No shift counts toward it yet. Choose it under &quot;Counts toward&quot; when you add or change a shift{seesVolunteer ? <> on the <Link href="/staff/volunteer">Volunteer</Link> page</> : ""}.</p> : (
            <ul className="lines">{shifts.map((x, i) => (
              <li key={i}><div>
                {seesVolunteer ? <Link className="what" href={`/staff/volunteer/${x.eventId}`}>{x.eventName}</Link> : <span className="what">{x.eventName}</span>}
                <span className="when">{dateWords(x.onDate)}, {shiftTimeWords(x.startsAt, x.endsAt)}{x.cancelled ? " · Cancelled" : ""}</span>
              </div></li>))}</ul>
          )}
          <p className="hint">A shift counts {r.amountUnit === "hours" ? "its length in hours" : "as one shift"}. Until check-in is built, nothing is confirmed: families see how much they are signed up for.</p>
        </section>
      )}

      {canChange && (
        <section className="box" aria-labelledby="remove-h"><h2 id="remove-h">Remove</h2>
          {recorded > 0
            ? <p>{recorded === 1 ? "A tick or waiver is" : `${recorded} ticks and waivers are`} recorded against this requirement, so it can&apos;t be removed. Clear them first on its progress page, or make it optional so it no longer holds the step open.</p>
            : <><p>Nothing is recorded against this requirement yet, so it can be removed.</p>
                <OneButton label="Remove this requirement" pendingLabel="Removing…" act={removeRequirementAction.bind(null, r.id)} goTo={back} /></>}
        </section>
      )}
    </main>
  );
}
