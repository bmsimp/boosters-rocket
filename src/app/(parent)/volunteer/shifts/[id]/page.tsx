import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { loadShiftForMe } from "@/lib/volunteer/my-volunteer";
import { placesWords } from "@/lib/volunteer/rules";
import { NotSetUpBox } from "../../../family-boxes";
import { signUpAction } from "../../actions";
import { SignUpForm } from "../../volunteer-forms";

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
    return <main className="wrap single"><h1 className="page-title">Volunteer</h1><NotSetUpBox treasurerEmail={club.treasurerEmail} /></main>;
  }
  const view = await loadShiftForMe(ctx, family, id);
  if (!view) notFound();
  const { event, shift } = view;
  return (
    <main className="wrap single volunteer-page">
      <h1 className="page-title">{event.name}</h1>
      <p className="lede">{event.dateWords}, {shift.timeWords}{shift.role ? `, ${shift.role}` : ""}. <Link href="/volunteer">Back to Volunteer</Link></p>

      <section className="box" aria-labelledby="shift-h"><h2 id="shift-h">The shift</h2>
        <dl className="details">
          <dt>When</dt><dd>{event.dateWords}, {shift.timeWords}</dd>
          {shift.role && <><dt>Doing</dt><dd>{shift.role}</dd></>}
          <dt>Where</dt><dd>{event.location}</dd>
          <dt>Places</dt><dd className="num">{placesWords(shift)}</dd>
          <dt>Contact</dt><dd>{event.contact}</dd>
        </dl>
        {event.description && <p className="volunteer-about">{event.description}</p>}
        {view.mine.length > 0 && <p className="help">Signed up from your family: {view.mine.map((m) => `${m.who === "You" ? "you" : m.who}${m.checkedIn ? " (checked in)" : ""}`).join(", ")}.</p>}
      </section>

      <section className="box" aria-labelledby="signup-h"><h2 id="signup-h">Sign up</h2>
        {shift.state === "started" ? <p className="state">This shift has started, so it&apos;s too late to sign up.</p>
          : shift.state === "full" ? <p className="state">This shift is full. Every place has been taken.</p>
          : <SignUpForm choices={view.choices} act={signUpAction.bind(null, shift.id)} />}
      </section>
    </main>
  );
}
