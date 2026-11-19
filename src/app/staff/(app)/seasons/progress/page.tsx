import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { listSeasons } from "@/lib/seasons/setup";
import { defaultProgressSeasonId, loadProgressOverview } from "@/lib/seasons/staff-progress";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";

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

      {!overview && <Notice tone="info" live="none" title="No season yet" titleId="none-h"><p>Once a season is set up, its requirements are listed here.</p></Notice>}

      {overview && (
        <>
          <section className="box" aria-labelledby="season-h"><h2 id="season-h">{overview.season.name}</h2>
            <Notice tone="info" live="none">{overview.season.isCurrent ? "The current season." : "Not the current season: parents don't see it."}</Notice>
            {overview.steps.length === 0 && <Notice tone="info" live="none">This season has no steps yet.</Notice>}
          </section>
          {overview.steps.map((step, i) => (
            <section className="box" key={step.id} aria-labelledby={`step-${step.id}`}>
              <h2 id={`step-${step.id}`}>{i + 1}. {step.name}</h2>
              {step.requirements.length === 0 ? <Notice tone="info" live="none">Nothing is asked in this step.</Notice> : (
                <DataTable caption={`What ${step.name} asks, and how many have done it`} captionHidden rows={step.requirements} rowKey={(r) => r.id} columns={[
                  { key: "title", header: "Requirement", rowHeader: true, cell: (r) => <Link href={`/staff/seasons/progress/${r.id}`}>{r.title}</Link> },
                  { key: "required", header: "Required", cell: (r) => (r.required ? "Required" : "Optional") },
                  { key: "asked", header: "Asked of", cell: (r) => (r.appliesTo === "family" ? "Each family" : "Each student") },
                  { key: "done", header: "Done", numeric: true, cell: (r) => tally(r.counts) },
                ]} />
              )}
            </section>
          ))}
        </>
      )}

      {seasons.length > 1 && (
        <section className="box" aria-labelledby="others-h"><h2 id="others-h">Other seasons</h2>
          <DataTable caption="The club's other seasons" captionHidden rows={seasons.filter((s) => s.id !== overview?.season.id)} rowKey={(s) => s.id} columns={[
            { key: "name", header: "Season", rowHeader: true, cell: (s) => <Link href={`/staff/seasons/progress?season=${s.id}`}>{s.name}</Link> },
            { key: "current", header: "Parents see it", cell: (s) => (s.isCurrent ? "Yes, the current season" : "No") },
          ]} />
        </section>
      )}
    </main>
  );
}
