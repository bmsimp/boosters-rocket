import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { loadMySeason, type MySeason } from "@/lib/seasons/my-season";
import type { Line } from "@/lib/seasons/progress";
import { getClubSettings } from "@/lib/settings/club";
import { loadMyVolunteering } from "@/lib/volunteer/my-volunteer";
import { placesWords } from "@/lib/volunteer/rules";
import { StateWords } from "../../components/state-words";
import { NotSetUpBox } from "../family-boxes";
import { RequirementLines } from "../season-parts";
import { cancelSignupAction } from "./actions";
import { CancelSignup } from "./volunteer-forms";

export const metadata = { title: "Volunteer" };

/** The volunteering the current season asks of the family and of each student, with where each stands. */
function volunteerLines(season: MySeason | null): { who: string; lines: Line[] }[] {
  if (!season) return [];
  const family = season.steps.flatMap((s) => s.family).filter((l) => l.kind === "volunteer");
  const students = new Map<string, { who: string; lines: Line[] }>();
  for (const step of season.steps) for (const s of step.students) {
    const lines = s.lines.filter((l) => l.kind === "volunteer");
    if (lines.length) students.set(s.qboId, { who: s.name, lines: [...(students.get(s.qboId)?.lines ?? []), ...lines] });
  }
  return [...(family.length ? [{ who: "Your family", lines: family }] : []), ...students.values()];
}

/**
 * Volunteer: what the club asks, the family's own sign-ups with a way to cancel, and the upcoming events with their
 * shifts. Of other families a parent sees only how many places each shift has filled. Everything is read for the
 * session's family alone (src/lib/volunteer/my-volunteer.ts).
 */
export default async function VolunteerPage() {
  const ctx = await requireParentPage("/volunteer");
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  if (!family) {
    return <main className="wrap single"><h1 className="page-title">Volunteer</h1><NotSetUpBox treasurerEmail={club.treasurerEmail} /></main>;
  }
  const [mine, season] = await Promise.all([loadMyVolunteering(ctx), loadMySeason(ctx, family.students)]);
  const asked = volunteerLines(season);
  return (
    <main className="wrap single volunteer-page">
      <h1 className="page-title">Volunteer</h1>
      <p className="lede">Shifts the club needs help with, for {family.name}. Pick one with a free place, then say who will do it.</p>

      {asked.length > 0 && (
        <section className="box" aria-labelledby="asked-h"><h2 id="asked-h">What the club asks</h2>
          {asked.map((a) => <div className="family-reqs" key={a.who}><h3>{a.who}</h3><RequirementLines lines={a.lines} today={season!.today} /></div>)}
        </section>
      )}

      <section className="box" aria-labelledby="mine-h"><h2 id="mine-h">Your sign-ups</h2>
        {mine.signups.length === 0 ? <p>Nobody in your family is signed up for a shift yet.</p> : (
          <ul className="lines">{mine.signups.map((s) => (
            <li key={s.id}><div>
              <span className="what">{s.eventName}{s.role ? `, ${s.role}` : ""}</span>
              <span className="when">{s.dateWords}, {s.timeWords} · {s.location}</span>
              <span className="when">{s.who === "You" ? "You're doing this one" : `${s.who} is doing this one`}</span>
              {s.cancel === "cancelled" ? <StateWords state="waived" words="The club cancelled this shift. There's nothing you need to do." />
                : <StateWords state="done" words="Signed up" />}
              {s.cancel === "open" && (
                <>
                  <span className="when">You can cancel here until {s.cancelUntil}.</span>
                  <CancelSignup label={s.who === "You" ? "Cancel my sign-up" : `Cancel ${s.who}'s sign-up`} act={cancelSignupAction.bind(null, s.id)} />
                </>
              )}
              {s.cancel === "closed" && <p className="help">It&apos;s less than {mine.cutoffHours} {mine.cutoffHours === 1 ? "hour" : "hours"} before the shift, so it can&apos;t be cancelled here. If you can&apos;t make it, please contact {s.contact}.</p>}
            </div></li>))}</ul>
        )}
      </section>

      {mine.events.length === 0 ? (
        <section className="box" aria-labelledby="events-h"><h2 id="events-h">Upcoming events</h2><p>There are no volunteer shifts coming up right now. Check back soon.</p></section>
      ) : mine.events.map((e) => (
        <section className="box" key={e.id} aria-labelledby={`event-${e.id}`}>
          <h2 id={`event-${e.id}`}>{e.name}</h2>
          <p>{e.dateWords} · {e.location}</p>
          {e.description && <p className="volunteer-about">{e.description}</p>}
          <p className="help">Questions? Contact {e.contact}.</p>
          <ul className="lines">{e.shifts.map((s) => (
            <li key={s.id}><div>
              <span className="what">{s.timeWords}{s.role ? `, ${s.role}` : ""}</span>
              <span className="when num">{placesWords(s)}</span>
            </div>
              {s.state === "open" ? <Link className="btn btn-club pay" href={`/volunteer/shifts/${s.id}`}>Sign up<span className="visually-hidden"> for {s.timeWords}{s.role ? `, ${s.role}` : ""}</span></Link>
                : <StateWords state="waived" words={s.state === "full" ? "Full" : "Started"} />}
            </li>))}</ul>
        </section>
      ))}
    </main>
  );
}
