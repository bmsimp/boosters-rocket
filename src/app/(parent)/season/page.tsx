import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { loadMySeason } from "@/lib/seasons/my-season";
import { linesLeft } from "@/lib/seasons/progress";
import { getClubSettings } from "@/lib/settings/club";
import { CalendarDate } from "../../components/calendar-date";
import { StateWords } from "../../components/state-words";
import { NotSetUpBox } from "../family-boxes";
import { RequirementLines } from "../season-parts";

export const metadata = { title: "Season" };

/** A step's dates in words; nothing when it has none. */
function StepDates({ startsOn, endsOn }: { startsOn: string | null; endsOn: string | null }) {
  if (startsOn && endsOn) return <><CalendarDate iso={startsOn} /> to <CalendarDate iso={endsOn} /></>;
  if (startsOn) return <>Starts <CalendarDate iso={startsOn} /></>;
  if (endsOn) return <>Ends <CalendarDate iso={endsOn} /></>;
  return null;
}

/**
 * The whole season for the signed-in family: every step in order, what each asks of the family and of each student,
 * and how each stands, in words. Reached from the ruler on Home; it has no tab.
 */
export default async function SeasonPage() {
  const ctx = await requireParentPage("/season");
  // The family comes from the session and nothing else: no address, query string or form chooses whose season this is.
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  const season = family ? await loadMySeason(ctx) : null;
  return (
    <main className="wrap single season-page">
      <h1 className="page-title">{season ? season.name : "Season"}</h1>
      {!family ? <NotSetUpBox treasurerEmail={club.treasurerEmail} />
        : !season ? <p className="lede">The club hasn&apos;t set up a season here yet. There&apos;s nothing you need to do.</p>
        : (
          <>
            <p className="lede">Every step of the season for {family.name}, and what&apos;s done so far. <Link href="/">Back to Home</Link></p>
            {season.steps.length === 0 && <p className="lede">The club hasn&apos;t added any steps yet.</p>}
            {season.steps.map((step, i) => {
              const students = step.students.filter((s) => s.lines.length > 0);
              const left = linesLeft(step.family) + step.students.reduce((sum, s) => sum + linesLeft(s.lines), 0);
              const asked = step.family.length > 0 || students.length > 0;
              const current = i === season.currentIndex, dated = step.startsOn !== null || step.endsOn !== null;
              return (
                <section className="box" key={step.id} aria-labelledby={`step-${i + 1}`}>
                  <h2 id={`step-${i + 1}`}>{i + 1}. {step.name}</h2>
                  {(current || dated) && <p>{current ? "The current step" : null}{current && dated ? " · " : null}<StepDates startsOn={step.startsOn} endsOn={step.endsOn} /></p>}
                  {!asked ? <p className="step-none">Nothing is asked of your family in this step.</p>
                    : <StateWords state={left === 0 ? "done" : "todo"} words={left === 0 ? "Done" : `${left} ${left === 1 ? "thing" : "things"} left to do`} />}
                  {step.family.length > 0 && (
                    <div className="family-reqs"><h3>Your family</h3><RequirementLines lines={step.family} today={season.today} /></div>
                  )}
                  {students.map((s) => (
                    <div className="family-reqs" key={String(s.id)}><h3>{s.name}</h3><RequirementLines lines={s.lines} today={season.today} /></div>
                  ))}
                </section>
              );
            })}
          </>
        )}
    </main>
  );
}
