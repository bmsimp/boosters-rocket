import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { loadShiftForMe } from "@/lib/volunteer/my-volunteer";
import { placesWords } from "@/lib/volunteer/rules";
import { NotSetUpBox } from "../../../family-boxes";
import { signUpAction } from "../../actions";
import { SignUpForm } from "../../volunteer-forms";
import { Card, KeyValue, Notice, PageHeader } from "../../../../components/ui";

export const metadata = { title: "Sign up for a shift" };

/**
 * One shift, to sign up for: the event, the time, how many places are filled, who in the family is on it already, and
 * the choice of who will do it, each with the requirements it would count toward. The shift in the address is untrusted:
 * one that isn't offered (unknown, cancelled) answers 404, and the sign-up itself is checked again by the action.
 */
export default async function ShiftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireParentPage(`/volunteer/shifts/${encodeURIComponent(id)}`);
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  if (!family) {
    return <main className="wrap single"><PageHeader title="Volunteer" /><NotSetUpBox treasurerEmail={club.treasurerEmail} /></main>;
  }
  const view = await loadShiftForMe(ctx, id);
  if (!view) notFound();
  const { event, shift } = view;
  return (
    <main className="wrap single volunteer-page">
      {/* The date, time and role are in the shift's own rows below: the head names the event alone. */}
      <PageHeader title={event.name} back={{ href: "/volunteer", label: "Back to Volunteer" }} />

      <Card title="The shift" titleId="shift-h">
        <KeyValue items={[
          { key: "when", label: "When", value: <>{event.dateWords}, {shift.timeWords}</> },
          shift.role ? { key: "doing", label: "Doing", value: shift.role } : null,
          { key: "where", label: "Where", value: event.location },
          { key: "places", label: "Places", value: placesWords(shift), numeric: true },
          { key: "contact", label: "Contact", value: event.contact },
        ]} />
        {event.description && <p className="volunteer-about">{event.description}</p>}
        {view.mine.length > 0 && <p className="help">Signed up from your family: {view.mine.map((m) => `${m.who === "You" ? "you" : m.who}${m.checkedIn ? " (checked in)" : ""}`).join(", ")}.</p>}
      </Card>

      <Card title="Sign up" titleId="signup-h">
        {shift.state === "started" ? <Notice tone="info" live="none">This shift has started, so it&apos;s too late to sign up.</Notice>
          : shift.state === "full" ? <Notice tone="info" live="none">This shift is full.</Notice>
          : <SignUpForm choices={view.choices} act={signUpAction.bind(null, shift.id)} />}
      </Card>
    </main>
  );
}
