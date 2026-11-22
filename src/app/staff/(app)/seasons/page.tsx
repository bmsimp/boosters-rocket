import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { listSeasons, TEMPLATE_STEPS } from "@/lib/seasons/setup";
import { DataTable } from "@/app/components/data-table";
import { NewSeasonForm } from "./forms";
import { createSeasonAction } from "./actions";

export const metadata = { title: "Seasons" };
export const dynamic = "force-dynamic";

export default async function SeasonsPage() {
  const ctx = await requireStaffPage("Season.Steps.Read");
  const seasons = await listSeasons();
  const canChange = can(ctx.effective, "Season.Steps.ReadWrite");
  return (
    <main className="wrap single">
      <h1 className="page-title">Seasons</h1>
      <p className="lede">A season is a list of steps, each holding what the club asks of families or students. Parents see the current one on Home.</p>
      {can(ctx.effective, "Season.Progress.Read") && <p className="lede"><Link className="link-line" href="/staff/seasons/progress">See who has done what</Link></p>}

      <section className="box" aria-labelledby="seasons-h"><h2 id="seasons-h">Seasons</h2>
        {seasons.length === 0 ? <p>There are no seasons yet.</p> : (
          <DataTable caption="The club's seasons, newest first" captionHidden rows={seasons} rowKey={(s) => s.id} columns={[
            { key: "name", header: "Season", rowHeader: true, cell: (s) => <Link href={`/staff/seasons/${s.id}`}>{s.name}</Link> },
            { key: "current", header: "Parents see it", cell: (s) => (s.isCurrent ? "Yes, the current season" : "No") },
            { key: "steps", header: "Steps", numeric: true, cell: (s) => s.steps },
            { key: "requirements", header: "Requirements", numeric: true, cell: (s) => s.requirements },
          ]} />
        )}
      </section>

      {canChange && (
        <section className="box" aria-labelledby="new-h"><h2 id="new-h">{seasons.length === 0 ? "Start your first season" : "Start a season"}</h2>
          <p>The template has {TEMPLATE_STEPS.length} steps: {TEMPLATE_STEPS.join(", ")}. Rename or remove them to fit your club.
            {seasons.length > 0 && " A copy takes the last season's steps and requirements, and leaves out its dates, ticks and waivers."}</p>
          <NewSeasonForm lastName={seasons[0]?.name ?? null} create={createSeasonAction} />
        </section>
      )}
    </main>
  );
}
