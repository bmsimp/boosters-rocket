import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { dateWords, hoursWords, shiftTimeWords } from "@/lib/volunteer/clock";
import { getEventSetup, volunteerRequirementChoices } from "@/lib/volunteer/setup";
import { LocalTime } from "@/app/components/local-time";
import { OneButton } from "../../seasons/forms";
import { addShiftAction, cancelEventAction, cancelShiftAction, copyEventAction, updateEventAction, updateShiftAction } from "../actions";
import { CopyForm, EventForm, ShiftForm } from "../forms";

export const metadata = { title: "Volunteer event" };
export const dynamic = "force-dynamic";

/**
 * One event: its details, its shifts, and who has signed up for each, by name. A list of people from many families,
 * like the roster's list, so opening it is not audited; every change is.
 */
export default async function VolunteerEventPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Volunteer.Event.Read");
  const { id } = await params;
  const event = isUuid(id) ? await getEventSetup(id) : null;
  if (!event) notFound();
  const canChange = can(ctx.effective, "Volunteer.Event.ReadWrite") && !event.cancelled;
  const choices = await volunteerRequirementChoices();
  const labelOf = (rid: string) => choices.find((c) => c.id === rid)?.label ?? "A requirement that is gone";
  const options = choices.map((c) => ({ id: c.id, label: `${c.label} (${c.unit}, ${c.appliesTo === "family" ? "each family" : "each student"})${c.current ? "" : " · not the current season"}` }));
  return (
    <main className="wrap single">
      <h1 className="page-title">{event.name}</h1>
      <p className="lede">{event.cancelled ? "Cancelled. Parents don't see it. " : ""}{dateWords(event.onDate)} · {event.location}. <Link href="/staff/volunteer">Back to Volunteer</Link>
        {event.copiedFrom && <> · Copied from <Link href={`/staff/volunteer/${event.copiedFrom.id}`}>{event.copiedFrom.name}, {dateWords(event.copiedFrom.onDate)}</Link></>}</p>

      <section className="box" aria-labelledby="about-h"><h2 id="about-h">The event</h2>
        <dl className="details">
          <dt>Contact</dt><dd>{event.contactName}{event.contactEmail ? ` (${event.contactEmail})` : ""}</dd>
          {event.description && <><dt>About</dt><dd className="volunteer-about">{event.description}</dd></>}
        </dl>
        {canChange && (
          <details className="more"><summary>Change the event</summary>
            <EventForm initial={{ name: event.name, onDate: event.onDate, location: event.location, description: event.description, contactName: event.contactName, contactEmail: event.contactEmail ?? "" }}
              save={updateEventAction.bind(null, event.id)} label="Save event" />
          </details>
        )}
      </section>

      {event.shifts.length === 0 && <section className="box" aria-labelledby="none-h"><h2 id="none-h">No shifts yet</h2><p>{canChange ? "Add the first shift below." : "Nobody can sign up until it has a shift."}</p></section>}

      {event.shifts.map((s) => (
        <section className="box" key={s.id} aria-labelledby={`shift-${s.id}`}>
          <h2 id={`shift-${s.id}`}>{shiftTimeWords(s.startsAt, s.endsAt)}{s.role ? `, ${s.role}` : ""}</h2>
          <p>{s.cancelled ? "Cancelled. " : ""}{s.signups.length} of {s.places} {s.places === 1 ? "place" : "places"} filled · {hoursWords(s.minutes)} {s.minutes === 60 ? "hour" : "hours"}</p>
          <p className="hint">{s.requirementIds.length === 0 ? "Counts toward no requirement." : `Counts toward: ${s.requirementIds.map(labelOf).join("; ")}.`}</p>
          {s.signups.length === 0 ? <p>Nobody has signed up yet.</p> : (
            <ul className="lines">{s.signups.map((x) => (
              <li key={x.id}><div>
                <span className="what">{x.fillerName}</span>
                <span className="when">{x.familyName}{x.fillerKind === "student" ? `, signed up by ${x.signedUpByName}` : ""} · <LocalTime iso={x.signedUpAt} /></span>
              </div></li>))}</ul>
          )}
          {canChange && !s.cancelled && (
            <details className="more"><summary>Change or cancel this shift</summary>
              <ShiftForm initial={{ startsAt: s.startsAt, endsAt: s.endsAt, places: s.places, role: s.role ?? "", requirementIds: s.requirementIds }} requirements={options}
                save={updateShiftAction.bind(null, s.id)} label="Save shift" />
              <OneButton label="Cancel this shift" pendingLabel="Cancelling…" act={cancelShiftAction.bind(null, s.id)} />
            </details>
          )}
        </section>
      ))}

      {canChange && (
        <>
          <section className="box" aria-labelledby="add-shift-h"><h2 id="add-shift-h">Add a shift</h2>
            <ShiftForm requirements={options} save={addShiftAction.bind(null, event.id)} label="Add shift" />
          </section>
          <section className="box" aria-labelledby="cancel-h"><h2 id="cancel-h">Cancel the event</h2>
            <p>Everyone signed up for its shifts is emailed. The event stays here, marked cancelled.</p>
            <OneButton label="Cancel this event" pendingLabel="Cancelling…" act={cancelEventAction.bind(null, event.id)} />
          </section>
        </>
      )}
      {can(ctx.effective, "Volunteer.Event.ReadWrite") && (
        <section className="box" aria-labelledby="copy-h"><h2 id="copy-h">Copy</h2>
          <p>Make the same event on another day, such as every home game, with its shifts. Nobody is signed up for the copy.</p>
          <CopyForm copy={copyEventAction.bind(null, event.id)} />
        </section>
      )}
    </main>
  );
}
