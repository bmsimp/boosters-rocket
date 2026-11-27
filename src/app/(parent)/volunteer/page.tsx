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
import { RequirementDue, RequirementTitle } from "../season-parts";
import { Card, EmptyState, LinkButton, List, ListRow, ListSubRow, PageHeader, StateWords } from "../../components/ui";
import { cancelSignupAction } from "./actions";
import { CancelSignup } from "./volunteer-forms";
import { Announcer } from "../announce";

export const metadata = { title: "Volunteer" };

/** The volunteering the current season asks of the family and of each student, with where each stands. */
function volunteerLines(season: MySeason | null): { key: string; who: string; lines: Line[] }[] {
  if (!season) return [];
  const family = season.steps.flatMap((s) => s.family).filter((l) => l.kind === "volunteer");
  const students = new Map<string, { key: string; who: string; lines: Line[] }>();
  for (const step of season.steps) for (const s of step.students) {
    const lines = s.lines.filter((l) => l.kind === "volunteer");
    // By the student's own record, never by name: two students may share one.
    if (lines.length) students.set(String(s.id), { key: String(s.id), who: s.name, lines: [...(students.get(String(s.id))?.lines ?? []), ...lines] });
  }
  return [...(family.length ? [{ key: "family", who: "Your family", lines: family }] : []), ...students.values()];
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
    return <main className="wrap single"><PageHeader title="Volunteer" /><NotSetUpBox treasurerEmail={club.treasurerEmail} /></main>;
  }
  const [mine, season, credit, buyouts] = await Promise.all([loadMyVolunteering(ctx), loadMySeason(ctx), loadMyCredit(ctx), loadMyBuyouts(ctx)]);
  const asked = volunteerLines(season);
  // Paying instead: offered on what isn't met yet, and shown wherever a buy-out stands (src/lib/buyouts/my-buyouts.ts).
  const payInstead = buyouts.filter((b) => b.buyout !== null || (b.may === "choose" && b.quote.ok));
  return (
    <main className="wrap single volunteer-page">
      <PageHeader title="Volunteer" lede={<>Shifts the club needs help with, for {family.name}. Pick one with a free place, then say who will do it.</>} />

      {asked.length > 0 && (
        // The family and each student a row, each requirement indented under it with where it stands, as on Home.
        <Card title="What the club asks" titleId="asked-h">
          <List>
            {asked.map((a) => (
              <ListRow key={a.key} title={a.who} sub={a.lines.map((line) => (
                <ListSubRow key={line.requirementId} title={<RequirementTitle line={line} />}
                  meta={<><StateWords state={line.state} words={line.words} /><RequirementDue line={line} today={season!.today} /></>} />
              ))} />
            ))}
          </List>
        </Card>
      )}

      {payInstead.length > 0 && (
        <Card title="Pay instead of volunteering" titleId="pay-h"
          description={<>If you can&apos;t make the shifts, you can pay for what&apos;s left instead. The club sends an invoice to your Payments page.</>}>
          <List>
            {payInstead.map((b) => (
              <ListRow key={`${b.requirementId}-${b.key}`} title={b.title} meta={[b.who, b.standing]}
                detail={b.buyout === null && b.quote.ok
                  ? <LinkButton size="sm" variant="tonal" className="pay" href={`/volunteer/pay-instead/${b.requirementId}/${b.key}`}>Pay instead of volunteering ({formatMoney(b.quote.amountCents)})<span className="visually-hidden">: {b.title}, {b.who}</span></LinkButton>
                  : <LinkButton size="sm" variant="tonal" className="pay" href={`/volunteer/pay-instead/${b.requirementId}/${b.key}`}>See your buy-out<span className="visually-hidden">: {b.title}, {b.who}</span></LinkButton>} />
            ))}
          </List>
        </Card>
      )}

      <Card title="Your sign-ups" titleId="mine-h">
        <Announcer>
        {mine.signups.length === 0 ? <p>Nobody in your family is signed up for a shift yet.</p> : (
          <List>
            {mine.signups.map((s) => (
              // A place is neutral while it stands ("Signed up") and done once checked in; one the club cancelled has no
              // state of its own, only the sentence under it.
              <ListRow key={s.id} title={<>{s.eventName}{s.role ? `, ${s.role}` : ""}</>}
                status={s.checkedIn ? { tone: "done", words: "Checked in" } : s.cancel === "cancelled" ? undefined : { tone: "neutral", words: "Signed up" }}
                meta={[<>{s.dateWords}, {s.timeWords} · {s.location}</>, s.who === "You" ? "You're doing this one" : `${s.who} is doing this one`]}
                detail={<>
                  {s.cancel === "cancelled" && <p className="help">The club cancelled this shift. There&apos;s nothing you need to do.</p>}
                  {s.cancel === "open" && (
                    <>
                      <span className="hint">You can cancel here until {s.cancelUntil}.</span>
                      <CancelSignup label={s.who === "You" ? "Cancel my sign-up" : `Cancel ${s.who}'s sign-up`} act={cancelSignupAction.bind(null, s.id)} />
                    </>
                  )}
                  {s.cancel === "closed" && s.corrected && <p className="help">The club has updated this check-in. If something isn&apos;t right, please talk to {s.contact}.</p>}
                  {s.cancel === "closed" && !s.checkedIn && !s.corrected && s.started && <p className="help">This shift has started. To check in, scan the club&apos;s check-in code at the shift. If you can&apos;t make it, please contact {s.contact}.</p>}
                  {s.cancel === "closed" && !s.checkedIn && !s.corrected && !s.started && <p className="help">It&apos;s less than {mine.cutoffHours} {mine.cutoffHours === 1 ? "hour" : "hours"} before the shift, so it can&apos;t be cancelled here. If you can&apos;t make it, please contact {s.contact}.</p>}
                </>} />
            ))}
          </List>
        )}
        </Announcer>
      </Card>

      {credit.length > 0 && (
        <Card title="Done so far" titleId="done-h" description={<>Thank you! Here&apos;s what your family has done so far, newest first.</>}>
          <List>
            {credit.map((c) => c.kind === "checkin"
              ? <ListRow key={c.id} status={{ tone: "done", words: c.words }} title={c.event} meta={[c.when, c.who === "You" ? "you" : c.who]} />
              : <ListRow key={c.id} status={{ tone: "done", words: c.words }} title={<>{c.amount} toward {c.toward}</>} meta={c.who} />)}
          </List>
        </Card>
      )}

      {mine.events.length === 0 ? (
        <Card title="Upcoming events" titleId="events-h"><EmptyState title="There are no volunteer shifts coming up right now.">Check back soon.</EmptyState></Card>
      ) : mine.events.map((e) => (
        <Card key={e.id} title={e.name} titleId={`event-${e.id}`} description={<>{e.dateWords} · {e.location}</>}>
          {e.description && <p className="volunteer-about">{e.description}</p>}
          <p className="help">Questions? Contact {e.contact}.</p>
          <List>
            {e.shifts.map((s) => (
              <ListRow key={s.id} title={<>{s.timeWords}{s.role ? `, ${s.role}` : ""}</>}
                status={s.state === "open" ? undefined : { tone: "neutral", words: s.state === "full" ? "Full" : "Started" }}
                meta={<span className="num">{placesWords(s)}</span>}
                action={s.state === "open" && <LinkButton size="sm" variant="tonal" className="pay" href={`/volunteer/shifts/${s.id}`}>Sign up<span className="visually-hidden"> for {s.timeWords}{s.role ? `, ${s.role}` : ""}</span></LinkButton>} />
            ))}
          </List>
        </Card>
      ))}
    </main>
  );
}
