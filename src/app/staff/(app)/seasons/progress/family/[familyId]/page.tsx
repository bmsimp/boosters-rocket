import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { isUuid } from "@/lib/seasons/ids";
import { pairKey } from "@/lib/seasons/kinds";
import { linesLeft, type Line } from "@/lib/seasons/progress";
import { defaultProgressSeasonId, loadFamilyProgress, type FamilyProgress } from "@/lib/seasons/staff-progress";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { StateWords } from "@/app/components/state-words";

export const metadata = { title: "Family progress" };
export const dynamic = "force-dynamic";

/**
 * What one step asks of the family itself or of one student, each requirement with its state in words. The title leads
 * to the requirement's own progress page, where it is ticked off or waived. Names, titles and reasons are text only.
 */
function Asked({ who, subjectQboId, lines, waivers }: { who: string; subjectQboId: string; lines: Line[]; waivers: FamilyProgress["waivers"] }) {
  return (
    <div className="family-reqs">
      <h3>{who}</h3>
      <ul className="lines progress-rows">{lines.map((line) => {
        const waiver = waivers.get(pairKey(line.requirementId, subjectQboId));
        return (
          <li key={line.requirementId}><div>
            <Link className="what" href={`/staff/seasons/progress/${line.requirementId}`}>{line.title}</Link>
            {!line.required && <span className="when">Optional</span>}
            <StateWords state={line.state} words={line.words} />
            {line.dueOn && <span className="when">Due <CalendarDate iso={line.dueOn} /></span>}
            {waiver && <span className="when">Waived <LocalTime iso={waiver.at} />{waiver.by ? ` by ${waiver.by}` : ""}: {waiver.reason}</span>}
          </div></li>
        );
      })}</ul>
    </div>
  );
}

/** One family's standing through a season, in full. The season is the current one unless the address asks for another. */
export default async function FamilyProgressPage({ params, searchParams }: {
  params: Promise<{ familyId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireStaffPage("Season.Progress.Read");
  const [{ familyId }, sp] = await Promise.all([params, searchParams]);
  // Both come from the address, so both are checked before anything is looked up.
  let qboId: string;
  try { qboId = decodeURIComponent(familyId); } catch { notFound(); }
  const asked = typeof sp.season === "string" ? sp.season : null;
  if (qboId.length === 0 || qboId.length > 64 || (asked !== null && !isUuid(asked))) notFound();
  const seasonId = asked ?? await defaultProgressSeasonId();
  const progress = seasonId ? await loadFamilyProgress(qboId, seasonId, can(ctx.effective, "Finance.Balance.Read") ? "all" : "none") : null;
  if (!progress) notFound();
  // A staff read of one family's data (spec §5): recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "season.progress.family.read", permission: "Season.Progress.Read",
    targetType: "qbo_customer", targetId: progress.family.qboId, ip: ctx.ip, after: { season: progress.season.name } });
  const { family, season, steps, currentIndex, waivers } = progress;
  return (
    <main className="wrap single season-page">
      <h1 className="page-title">{family.name}</h1>
      <p className="lede">Where this family stands in {season.name}{season.isCurrent ? ", the current season" : ", which parents don't see"}. Open a requirement to tick it off or waive it.{" "}
        <Link href={`/staff/seasons/progress?season=${season.id}`}>Back to {season.name}</Link></p>

      {steps.length === 0 && <section className="box" aria-labelledby="none-h"><h2 id="none-h">No steps yet</h2><p>This season has no steps yet.</p></section>}

      {steps.map((step, i) => {
        const students = step.students.filter((s) => s.lines.length > 0);
        const left = linesLeft(step.family) + step.students.reduce((sum, s) => sum + linesLeft(s.lines), 0);
        const anything = step.family.length > 0 || students.length > 0;
        return (
          <section className="box" key={step.id} aria-labelledby={`step-${step.id}`}>
            <h2 id={`step-${step.id}`}>{i + 1}. {step.name}</h2>
            {i === currentIndex && <p>The step this family is on.</p>}
            {!anything ? <p>Nothing is asked of this family in this step.</p>
              : <StateWords state={left === 0 ? "done" : "todo"} words={left === 0 ? "Done" : `${left} ${left === 1 ? "thing" : "things"} left to do`} />}
            {step.family.length > 0 && <Asked who="The family" subjectQboId={family.qboId} lines={step.family} waivers={waivers} />}
            {students.map((s) => <Asked key={s.qboId} who={s.name} subjectQboId={s.qboId} lines={s.lines} waivers={waivers} />)}
          </section>
        );
      })}
    </main>
  );
}
