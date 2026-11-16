import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { KIND_LABELS, KIND_RULES, REQUIREMENT_KINDS } from "@/lib/seasons/kinds";
import { stepsOutOfOrder } from "@/lib/seasons/progress";
import { describeRequirement, getSeasonSetup } from "@/lib/seasons/setup";
import { rosterListsNoStudents } from "@/lib/seasons/subjects";
import { CalendarDate } from "@/app/components/calendar-date";
import { Notice } from "@/app/components/notice";
import { OneButton, RequirementForm, StepForm, TextAction, type KindChoice } from "../forms";
import {
  addRequirementAction, addStepAction, clearCurrentSeasonAction, moveStepAction, removeStepAction, renameSeasonAction, setCurrentSeasonAction, updateStepAction,
} from "../actions";

export const metadata = { title: "Season" };
export const dynamic = "force-dynamic";

/** A step's dates in words; nothing when it has none. */
function StepDates({ startsOn, endsOn }: { startsOn: string | null; endsOn: string | null }) {
  if (startsOn && endsOn) return <span className="when"><CalendarDate iso={startsOn} /> to <CalendarDate iso={endsOn} /></span>;
  if (startsOn) return <span className="when">Starts <CalendarDate iso={startsOn} /></span>;
  if (endsOn) return <span className="when">Ends <CalendarDate iso={endsOn} /></span>;
  return <span className="when">No dates</span>;
}

export default async function SeasonPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Season.Steps.Read");
  const { id } = await params;
  const season = isUuid(id) ? await getSeasonSetup(id) : null;
  if (!season) notFound();
  const canChange = can(ctx.effective, "Season.Steps.ReadWrite"), seesProgress = can(ctx.effective, "Season.Progress.Read");
  const kinds: KindChoice[] = REQUIREMENT_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k], available: KIND_RULES[k] !== null }));
  const dated = season.steps.some((s) => s.startsOn !== null || s.endsOn !== null);
  // The current step follows the order of the steps, so one dated out of turn is passed over: staff are told which.
  const outOfOrder = stepsOutOfOrder(season.steps).map((i) => season.steps[i]!.name);
  // A club whose roster lists no students is offered only requirements for each family: one for each student would be asked of nobody.
  const perStudent = canChange ? !(await rosterListsNoStudents()) : true;
  return (
    <main className="wrap single">
      <h1 className="page-title">{season.name}</h1>
      <p className="lede">{season.isCurrent ? "The current season: parents see it on their Home page." : "Not the current season: parents don't see it."} <Link href="/staff/seasons">Back to Seasons</Link>
        {seesProgress && <> · <Link href={`/staff/seasons/progress?season=${season.id}`}>See who has done what</Link></>}</p>

      {canChange && (
        <section className="box" aria-labelledby="season-h"><h2 id="season-h">This season</h2>
          <TextAction field="Season name" label="Rename" pendingLabel="Renaming…" initial={season.name} maxLength={60} act={renameSeasonAction.bind(null, season.id)} />
          <div className="box-foot">
            {season.isCurrent
              ? <OneButton label="Stop showing this season to parents" pendingLabel="Saving…" act={clearCurrentSeasonAction} />
              : <OneButton label="Make this the current season" pendingLabel="Saving…" act={setCurrentSeasonAction.bind(null, season.id)} primary />}
          </div>
        </section>
      )}

      <section className="box" aria-labelledby="how-h"><h2 id="how-h">Which step is the current one</h2>
        <p>{dated
          ? "By date: the first step that hasn't ended. A step ends when its end date has passed or, if it has none, when a later step starts or ends. A step that follows one with no end date needs a start date to be marked in its turn. Dates follow the club's time zone, set under Club."
          : "No step has a date, so each family is on the first step that not everyone in it has finished. Give any step a date and the whole club moves through the steps by date instead."}</p>
        {outOfOrder.length > 0 && (
          <Notice tone="warning">
            The dates are out of order. {outOfOrder.length === 1 ? <>{outOfOrder[0]} starts or ends</> : <>{outOfOrder.join(", ")} each start or end</>} before a step that comes earlier in this list.
            {" "}The steps are followed in the order shown here, so a step dated out of turn is passed over and is never the current one. Change the dates, or move the step.
          </Notice>
        )}
      </section>

      {season.steps.length === 0 && <section className="box" aria-labelledby="none-h"><h2 id="none-h">No steps yet</h2><p>Add the first step below.</p></section>}

      {season.steps.map((step, i) => (
        <section className="box" key={step.id} aria-labelledby={`step-${step.id}`}>
          <h2 id={`step-${step.id}`}>{i + 1}. {step.name}</h2>
          <p><StepDates startsOn={step.startsOn} endsOn={step.endsOn} /></p>
          {step.requirements.length === 0 ? <p>Nothing is asked in this step yet, so everyone has finished it.</p> : (
            <ul className="lines">{step.requirements.map((r) => (
              <li key={r.id}><div>
                <Link className="what" href={`/staff/seasons/${season.id}/requirements/${r.id}`}>{r.title}</Link>
                <span className="when">{describeRequirement(r)} · {r.covers === "everyone" ? "Everyone" : `A chosen list of ${r.coveredQboIds.length}`}</span>
                {r.dueOn && <span className="when">Due <CalendarDate iso={r.dueOn} /></span>}
                {seesProgress && <span className="when"><Link href={`/staff/seasons/progress/${r.id}`}>Who has done it</Link></span>}
              </div></li>))}</ul>
          )}
          {canChange && (
            <>
              <details className="more"><summary>Add a requirement to {step.name}</summary>
                <RequirementForm kinds={kinds} perStudent={perStudent} add={addRequirementAction.bind(null, step.id)} />
              </details>
              <details className="more"><summary>Change, move or remove {step.name}</summary>
                <StepForm initial={{ name: step.name, startsOn: step.startsOn, endsOn: step.endsOn }} save={updateStepAction.bind(null, step.id)} />
                <div className="row-actions">
                  {i > 0 && <OneButton label="Move earlier" pendingLabel="Moving…" act={moveStepAction.bind(null, step.id, "earlier")} />}
                  {i < season.steps.length - 1 && <OneButton label="Move later" pendingLabel="Moving…" act={moveStepAction.bind(null, step.id, "later")} />}
                  <OneButton label="Remove this step" pendingLabel="Removing…" act={removeStepAction.bind(null, step.id)} />
                </div>
              </details>
            </>
          )}
        </section>
      ))}

      {canChange && (
        <section className="box" aria-labelledby="add-step-h"><h2 id="add-step-h">Add a step</h2>
          <TextAction field="Step name" label="Add step" pendingLabel="Adding…" maxLength={60} act={addStepAction.bind(null, season.id)} />
        </section>
      )}
    </main>
  );
}
