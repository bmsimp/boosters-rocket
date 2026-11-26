import { ConfirmDialog, Drawer, LinkButton } from "@/app/components/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { dateWords, hoursWords, shiftTimeWords } from "@/lib/volunteer/clock";
import { getEventSetup, volunteerRequirementChoices, type StaffSignup } from "@/lib/volunteer/setup";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { LocalTime } from "@/app/components/local-time";
import { DataTable } from "@/app/components/data-table";
import { OneButton } from "../../seasons/forms";
import { addShiftAction, cancelEventAction, cancelShiftAction, copyEventAction, removeSignupAction, updateEventAction, updateShiftAction } from "../actions";
import { addCheckInAction, removeCreditAction } from "../credit/actions";
import { CopyForm, EventForm, ShiftForm } from "../forms";

export const metadata = { title: "Volunteer event" };
export const dynamic = "force-dynamic";

/**
 * One event: its details, its shifts, and who has signed up for each, by name, with whether each is checked in. A list
 * of people from many families, like the roster's list, so opening it is not audited; every change is. Staff who can
 * change events print each shift's check-in code and take a person off a shift; staff who correct credit add a missed
 * check-in once a shift has started, or remove one, with a reason only staff see.
 */
export default async function VolunteerEventPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Volunteer.Event.Read");
  const { id } = await params;
  // Read before the sign-ups: a change of company in between makes the tag the older one, and a correction is refused.
  const rosterTag = await currentRosterTag();
  const event = isUuid(id) ? await getEventSetup(id) : null;
  if (!event) notFound();
  const canChange = can(ctx.effective, "Volunteer.Event.ReadWrite") && !event.cancelled;
  const canPrint = can(ctx.effective, "Volunteer.Event.ReadWrite");
  const canCredit = can(ctx.effective, "Volunteer.Credit.ReadWrite");
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
          <div className="row-actions"><Drawer param="event" label="Change the event">
            <EventForm initial={{ name: event.name, onDate: event.onDate, location: event.location, description: event.description, contactName: event.contactName, contactEmail: event.contactEmail ?? "" }}
              save={updateEventAction.bind(null, event.id)} label="Save event" />
          </Drawer></div>
        )}
      </section>

      {event.shifts.length === 0 && <section className="box" aria-labelledby="none-h"><h2 id="none-h">No shifts yet</h2><p>{canChange ? "Add the first shift below." : "Nobody can sign up until it has a shift."}</p></section>}

      {event.shifts.map((s) => (
        <section className="box" key={s.id} aria-labelledby={`shift-${s.id}`}>
          <h2 id={`shift-${s.id}`}>{shiftTimeWords(s.startsAt, s.endsAt)}{s.role ? `, ${s.role}` : ""}</h2>
          <p>{s.cancelled ? "Cancelled. " : ""}{s.signups.length} of {s.places} {s.places === 1 ? "place" : "places"} filled · {hoursWords(s.minutes)} {s.minutes === 60 ? "hour" : "hours"}</p>
          <p className="hint">{s.requirementIds.length === 0 ? "Counts toward no requirement." : `Counts toward: ${s.requirementIds.map(labelOf).join("; ")}.`}</p>
          {canPrint && !s.cancelled && <p><LinkButton variant="secondary" size="sm" href={`/staff/volunteer/check-in/${s.id}`}>Check-in code to print</LinkButton></p>}
          {s.signups.length === 0 ? <p>Nobody has signed up yet.</p> : (
            <DataTable caption="Who has signed up for this shift" captionHidden rows={s.signups} rowKey={(x) => x.id} columns={[
              { key: "who", header: "Who", rowHeader: true, cell: (x) => x.fillerName },
              { key: "family", header: "Family", cell: (x) => <>{x.familyName}{x.fillerKind === "student" ? `, signed up by ${x.signedUpByName}` : ""}</> },
              { key: "when", header: "Signed up", cell: (x) => <LocalTime iso={x.signedUpAt} /> },
              // Plain words: the state icons mean done, to do and waived.
              { key: "checkin", header: "Check-in", cell: (x) => (
                <><b>{x.checkIn ? (x.checkIn.byStaff ? `Checked in (added by ${x.checkIn.byStaff})` : "Checked in") : s.started ? "Not checked in" : "Signed up"}</b>
                  {x.checkIn && <span className="when">Checked in <LocalTime iso={x.checkIn.at} /></span>}</>) },
              ...(canCredit || canPrint ? [{ key: "do", header: "What you can do", quiet: true, cell: (x: StaffSignup) => (
                <>
                  {canCredit && x.checkIn && (
                    <ConfirmDialog label="Remove this check-in" size="sm" title={`Remove the check-in of ${x.fillerName}?`} confirmLabel="Remove the check-in" busyLabel="Removing…"
                      consequence="The credit it earned stops counting. Only staff see your reason."
                      reason={{ label: "Why it's being removed (only staff see this)", maxLength: 500 }}
                      act={removeCreditAction.bind(null, x.checkIn.creditId, rosterTag)} />
                  )}
                  {canCredit && !x.checkIn && s.started && !s.cancelled && !event.cancelled && (
                    <OneButton label={`Check in ${x.fillerName}`} pendingLabel="Checking in…" act={addCheckInAction.bind(null, x.id, rosterTag)} />
                  )}
                  {canPrint && !x.checkIn && (
                    <ConfirmDialog label={`Take ${x.fillerName} off this shift`} size="sm" busyLabel="Removing…"
                      consequence={`The place is freed${s.ended ? "" : ", and the guardian who signed up is emailed"}.`}
                      act={removeSignupAction.bind(null, x.id)} />
                  )}
                </>) }] : []),
            ]} />
          )}
          {canChange && !s.cancelled && (
            <div className="row-actions"><Drawer param="shift" value={s.id} label="Change or cancel this shift">
              <ShiftForm initial={{ startsAt: s.startsAt, endsAt: s.endsAt, places: s.places, role: s.role ?? "", requirementIds: s.requirementIds }} requirements={options}
                save={updateShiftAction.bind(null, s.id)} label="Save shift" />
              <ConfirmDialog label="Cancel this shift" busyLabel="Cancelling…"
                consequence="Everyone signed up for it is emailed, and its places are no longer offered. This can't be undone."
                act={cancelShiftAction.bind(null, s.id)} />
            </Drawer></div>
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
            <ConfirmDialog label="Cancel this event" busyLabel="Cancelling…"
              consequence="Everyone signed up for any of its shifts is emailed. This can't be undone."
              act={cancelEventAction.bind(null, event.id)} />
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
