import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { listSeasons } from "@/lib/seasons/setup";
import { defaultProgressSeasonId, loadProgressOverview } from "@/lib/seasons/staff-progress";

export const metadata = { title: "Season progress" };
export const dynamic = "force-dynamic";

/** "12 of 40 done, 2 waived", in words. */
const tally = (c: { asked: number; done: number; waived: number }) =>
  c.asked === 0 ? "Asked of nobody on the roster" : `${c.done} of ${c.asked} done${c.waived ? `, ${c.waived} waived` : ""}`;

export default async function ProgressPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Season.Progress.Read");
  const sp = await searchParams;
  // The season comes from the address, so it is checked before it is looked up; with none, the current season is shown.
  const asked = typeof sp.season === "string" ? sp.season : null;
  if (asked !== null && !isUuid(asked)) notFound();
  const [seasons, seasonId] = await Promise.all([listSeasons(), asked ?? defaultProgressSeasonId()]);
  const overview = seasonId ? await loadProgressOverview(seasonId) : null;
  if (asked !== null && !overview) notFound();
  const seesSetup = can(ctx.effective, "Season.Steps.Read");
  return (
    <main className="wrap single">
      <h1 className="page-title">Season progress</h1>
      <p className="lede">Who has done what the season asks. Open a requirement to tick it off for a family or student, or to waive it.
        {seesSetup && <> <Link href="/staff/seasons">Set up seasons</Link></>}</p>

      {!overview && <section className="box" aria-labelledby="none-h"><h2 id="none-h">No season yet</h2><p>Once a season is set up, its requirements are listed here.</p></section>}

      {overview && (
        <>
          {!overview.roster && <p role="status" className="box">The roster can&apos;t be shown right now, so nobody is listed under any requirement. Check QuickBooks under Roster.</p>}
          <section className="box" aria-labelledby="season-h"><h2 id="season-h">{overview.season.name}</h2>
            <p>{overview.season.isCurrent ? "The current season." : "Not the current season: parents don't see it."}</p>
            {overview.steps.length === 0 && <p>This season has no steps yet.</p>}
          </section>
          {overview.steps.map((step, i) => (
            <section className="box" key={step.id} aria-labelledby={`step-${step.id}`}>
              <h2 id={`step-${step.id}`}>{i + 1}. {step.name}</h2>
              {step.requirements.length === 0 ? <p>Nothing is asked in this step.</p> : (
                <ul className="lines">{step.requirements.map((r) => (
                  <li key={r.id}><div>
                    <Link className="what" href={`/staff/seasons/progress/${r.id}`}>{r.title}</Link>
                    <span className="when">{r.required ? "Required" : "Optional"} · {r.appliesTo === "family" ? "Each family" : "Each student"}</span>
                  </div><span className="amount num">{overview.roster ? tally(r.counts) : ""}</span></li>))}</ul>
              )}
            </section>
          ))}
        </>
      )}

      {seasons.length > 1 && (
        <section className="box" aria-labelledby="others-h"><h2 id="others-h">Other seasons</h2>
          <ul className="lines">{seasons.filter((s) => s.id !== overview?.season.id).map((s) => (
            <li key={s.id}><div><Link className="what" href={`/staff/seasons/progress?season=${s.id}`}>{s.name}</Link>{s.isCurrent && <span className="when">Current season</span>}</div></li>))}</ul>
        </section>
      )}
    </main>
  );
}
