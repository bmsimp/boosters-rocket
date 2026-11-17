import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { loadMyBuyouts } from "@/lib/buyouts/my-buyouts";
import { formatMoney } from "@/lib/money/cents";
import { loadMyFamily } from "@/lib/parents/my-family";
import { loadMySeason, type MySeason } from "@/lib/seasons/my-season";
import type { Line } from "@/lib/seasons/progress";
import { getClubSettings } from "@/lib/settings/club";
import { loadMyCredit } from "@/lib/volunteer/credit";
import { loadMyVolunteering } from "@/lib/volunteer/my-volunteer";
import { placesWords } from "@/lib/volunteer/rules";
import { NotSetUpBox } from "../family-boxes";
import { RequirementLines } from "../season-parts";
import { cancelSignupAction } from "./actions";
import { CancelSignup } from "./volunteer-forms";
import { Announcer } from "../announce";

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
  const [mine, season, credit, buyouts] = await Promise.all([loadMyVolunteering(ctx), loadMySeason(ctx, family.students), loadMyCredit(ctx, family.students ?? []), loadMyBuyouts(ctx, family)]);
  const asked = volunteerLines(season);
  // Paying instead: offered on what isn't met yet, and shown wherever a buy-out stands (src/lib/buyouts/my-buyouts.ts).
  const payInstead = buyouts.filter((b) => b.buyout !== null || (b.may === "choose" && b.quote.ok));
  return (
    <main className="wrap single volunteer-page">
      <h1 className="page-title">Volunteer</h1>
      <p className="lede">Shifts the club needs help with, for {family.name}. Pick one with a free place, then say who will do it.</p>

      {asked.length > 0 && (
        <section className="box" aria-labelledby="asked-h"><h2 id="asked-h">What the club asks</h2>
          {asked.map((a) => <div className="family-reqs" key={a.who}><h3>{a.who}</h3><RequirementLines lines={a.lines} today={season!.today} /></div>)}
        </section>
      )}

      {payInstead.length > 0 && (
        <section className="box" aria-labelledby="pay-h"><h2 id="pay-h">Pay instead of volunteering</h2>
          <p>If you can&apos;t make the shifts, you can pay for what&apos;s left instead. The club sends an invoice to your Payments page.</p>
          <ul className="lines">{payInstead.map((b) => (
            <li key={`${b.requirementId}-${b.key}`}><div>
              <span className="what">{b.title}</span>
              <span className="when">{b.who}</span>
              <span className="state">{b.standing}</span>
            </div>
              {b.buyout === null && b.quote.ok
                ? <Link className="btn btn-club pay" href={`/volunteer/pay-instead/${b.requirementId}/${b.key}`}>Pay instead of volunteering ({formatMoney(b.quote.amountCents)})<span className="visually-hidden">: {b.title}, {b.who}</span></Link>
                : <Link className="btn btn-line pay" href={`/volunteer/pay-instead/${b.requirementId}/${b.key}`}>See your buy-out<span className="visually-hidden">: {b.title}, {b.who}</span></Link>}
            </li>))}</ul>
        </section>
      )}

      <section className="box" aria-labelledby="mine-h"><h2 id="mine-h">Your sign-ups</h2>
        <Announcer>
        {mine.signups.length === 0 ? <p>Nobody in your family is signed up for a shift yet.</p> : (
          <ul className="lines">{mine.signups.map((s) => (
            <li key={s.id}><div>
              <span className="what">{s.eventName}{s.role ? `, ${s.role}` : ""}</span>
              <span className="when">{s.dateWords}, {s.timeWords} · {s.location}</span>
              <span className="when">{s.who === "You" ? "You're doing this one" : `${s.who} is doing this one`}</span>
              {/* Plain words: the state icons mean done, to do and waived, and a place is none of those. */}
              <span className="state">{s.checkedIn ? "Checked in" : s.cancel === "cancelled" ? "The club cancelled this shift. There's nothing you need to do." : "Signed up"}</span>
              {s.cancel === "open" && (
                <>
                  <span className="when">You can cancel here until {s.cancelUntil}.</span>
                  <CancelSignup label={s.who === "You" ? "Cancel my sign-up" : `Cancel ${s.who}'s sign-up`} act={cancelSignupAction.bind(null, s.id)} />
                </>
              )}
              {s.cancel === "closed" && s.corrected && <p className="help">The club has updated this check-in. If something isn&apos;t right, please talk to {s.contact}.</p>}
              {s.cancel === "closed" && !s.checkedIn && !s.corrected && s.started && <p className="help">This shift has started. To check in, scan the club&apos;s check-in code at the shift. If you can&apos;t make it, please contact {s.contact}.</p>}
              {s.cancel === "closed" && !s.checkedIn && !s.corrected && !s.started && <p className="help">It&apos;s less than {mine.cutoffHours} {mine.cutoffHours === 1 ? "hour" : "hours"} before the shift, so it can&apos;t be cancelled here. If you can&apos;t make it, please contact {s.contact}.</p>}
            </div></li>))}</ul>
        )}
        </Announcer>
      </section>

      {credit.length > 0 && (
        <section className="box" aria-labelledby="done-h"><h2 id="done-h">Done so far</h2>
          <p>Thank you! This is the volunteering your family has to its name, newest first.</p>
          <ul className="lines">{credit.map((c) => (
            <li key={c.id}><div>
              {c.kind === "checkin" ? (
                <>
                  <span className="what">{c.event}</span>
                  <span className="when">{c.when} · {c.who === "You" ? "you" : c.who}</span>
                </>
              ) : (
                <>
                  <span className="what">{c.amount} toward {c.toward}</span>
                  <span className="when">{c.who}</span>
                </>
              )}
              <span className="state">{c.words}</span>
            </div></li>))}</ul>
        </section>
      )}

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
                : <span className="state">{s.state === "full" ? "Full" : "Started"}</span>}
            </li>))}</ul>
        </section>
      ))}
    </main>
  );
}
