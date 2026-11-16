import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { listEvents, type EventSummary } from "@/lib/volunteer/setup";
import { getVolunteerSettings } from "@/lib/volunteer/settings";
import { dateWords } from "@/lib/volunteer/clock";
import { createEventAction, saveCutoffAction } from "./actions";
import { CutoffForm, EventForm } from "./forms";

export const metadata = { title: "Volunteer" };
export const dynamic = "force-dynamic";

function EventList({ events }: { events: EventSummary[] }) {
  return (
    <ul className="lines">{events.map((e) => (
      <li key={e.id}><div>
        <Link className="what" href={`/staff/volunteer/${e.id}`}>{e.name}</Link>
        <span className="when">{dateWords(e.onDate)} · {e.location}</span>
        <span className="when">{e.cancelled ? "Cancelled" : e.shifts === 0 ? "No shifts yet" : `${e.shifts} ${e.shifts === 1 ? "shift" : "shifts"} · ${e.filled} of ${e.places} places filled`}</span>
      </div></li>))}</ul>
  );
}

/** Volunteer events, the soonest first, then earlier ones; a new event; and the cut-off for cancelling. */
export default async function VolunteerEventsPage() {
  const ctx = await requireStaffPage("Volunteer.Event.Read");
  const canChange = can(ctx.effective, "Volunteer.Event.ReadWrite");
  const canCredit = can(ctx.effective, "Volunteer.Credit.ReadWrite");
  const [{ upcoming, past }, { cutoffHours }] = await Promise.all([listEvents(), getVolunteerSettings()]);
  return (
    <main className="wrap single">
      <h1 className="page-title">Volunteer</h1>
      <p className="lede">Events with shifts that families sign up for. Parents see each shift and how many places are filled, never who. Dates and times are the club&apos;s own, in the time zone set under Club.</p>

      <section className="box" aria-labelledby="upcoming-h"><h2 id="upcoming-h">Coming up</h2>
        {upcoming.length === 0 ? <p>No events coming up.{canChange ? " Add one below." : ""}</p> : <EventList events={upcoming} />}
      </section>

      {canCredit && (
        <section className="box" aria-labelledby="credit-h"><h2 id="credit-h">Credit</h2>
          <p>Check-ins count as volunteering done. See each family&apos;s credit, and credit volunteering done outside the portal, under <Link href="/staff/volunteer/credit">Volunteer credit</Link>.</p>
        </section>
      )}

      {canChange && (
        <section className="box" aria-labelledby="new-h"><h2 id="new-h">Add an event</h2>
          <EventForm save={createEventAction} label="Add event" />
        </section>
      )}

      <section className="box" aria-labelledby="cutoff-h"><h2 id="cutoff-h">Cancelling</h2>
        <p>A guardian can cancel a sign-up on the portal until {cutoffHours} {cutoffHours === 1 ? "hour" : "hours"} before the shift starts. After that, the page asks them to contact the event&apos;s contact.</p>
        {canChange && <details className="more"><summary>Change the cut-off</summary><CutoffForm initial={cutoffHours} save={saveCutoffAction} /></details>}
      </section>

      {past.length > 0 && (
        <section className="box" aria-labelledby="past-h"><h2 id="past-h">Earlier events</h2><EventList events={past} /></section>
      )}
    </main>
  );
}
