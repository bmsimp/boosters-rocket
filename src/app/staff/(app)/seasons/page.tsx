import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { listSeasons, TEMPLATE_STEPS } from "@/lib/seasons/setup";
import { NewSeasonForm } from "./forms";
import { createSeasonAction } from "./actions";

export const metadata = { title: "Seasons" };
export const dynamic = "force-dynamic";

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export default async function SeasonsPage() {
  const ctx = await requireStaffPage("Season.Steps.Read");
  const seasons = await listSeasons();
  const canChange = can(ctx.effective, "Season.Steps.ReadWrite");
  return (
    <main className="wrap single">
      <h1 className="page-title">Seasons</h1>
      <p className="lede">A season is a list of steps, and each step holds what the club asks of every family or student. Parents see the current season on their Home page.</p>
      {can(ctx.effective, "Season.Progress.Read") && <p className="lede"><Link href="/staff/seasons/progress">See who has done what</Link></p>}

      <section className="box" aria-labelledby="seasons-h"><h2 id="seasons-h">Seasons</h2>
        {seasons.length === 0 ? <p>There are no seasons yet.</p> : (
          <ul className="lines">{seasons.map((s) => (
            <li key={s.id}><div>
              <Link className="what" href={`/staff/seasons/${s.id}`}>{s.name}</Link>
              <span className="when">{s.isCurrent ? "Current season: parents see it · " : ""}{n(s.steps, "step", "steps")} · {n(s.requirements, "requirement", "requirements")}</span>
            </div></li>))}</ul>
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
