import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { loadCheckInForMe, type CheckInView } from "@/lib/volunteer/check-in";
import { NotSetUpBox } from "../../../family-boxes";
import { checkInAction } from "../../actions";
import { CheckInButton } from "../../volunteer-forms";
import { Announcer } from "../../../announce";

export const metadata = { title: "Check in" };

/** What the page says about the window when nobody can be checked in right now. */
function closedWords(view: CheckInView): string | null {
  if (view.state === "cancelled") return "The club cancelled this shift, so there's nothing to check in for.";
  if (view.state === "before") return `Check-in opens ${view.opensWords}, half an hour before the shift starts. Come back then.`;
  if (view.state === "closed") return `Check-in for this shift has closed: it's over. If you helped and weren't checked in, please tell ${view.contact}.`;
  return null;
}

/**
 * The page a shift's check-in code opens (v1 spec §11.4). The code in the address is untrusted: one that opens no
 * shift answers 404. It shows the shift and the family's own people on it, and only inside the window (30 minutes
 * before the start until the end) offers a button for each; reading the page records nothing. Of anyone else on the
 * shift it shows nothing at all.
 */
export default async function CheckInPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const ctx = await requireParentPage(`/volunteer/check-in/${encodeURIComponent(code)}`);
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  if (!family) {
    return <main className="wrap single"><h1 className="page-title">Check in</h1><NotSetUpBox treasurerEmail={club.treasurerEmail} /></main>;
  }
  const view = await loadCheckInForMe(ctx, code);
  if (!view) notFound();
  const closed = closedWords(view);
  const waiting = view.people.filter((p) => !p.checkedIn && !p.corrected);
  return (
    <main className="wrap single volunteer-page">
      <h1 className="page-title">Check in</h1>
      <p className="lede">{view.event}{view.role ? `, ${view.role}` : ""}: {view.dateWords}, {view.timeWords} · {view.location}</p>

      <section className="box" aria-labelledby="checkin-h"><h2 id="checkin-h">{family.name}</h2>
        {view.people.length === 0 ? (
          <p>Nobody in your family is signed up for this shift, so there&apos;s no one to check in here. If you&apos;d like to help, you can find a shift with a free place on the <Link href="/volunteer">Volunteer page</Link>.</p>
        ) : (
          <Announcer>
            {closed && <p className="state">{closed}</p>}
            <ul className="lines">{view.people.map((p) => (
              <li key={p.signupId}><div>
                <span className="what">{p.who === "You" ? "You" : p.who}</span>
                {/* Plain words: the state icons mean done, to do and waived. */}
                <span className="state">{p.checkedIn ? "Checked in" : p.corrected ? "Updated by the club" : "Not checked in yet"}</span>
              </div>
                {p.corrected && <p className="help">The club has updated this check-in. If something isn&apos;t right, please talk to {view.contact}.</p>}
                {!p.checkedIn && !p.corrected && view.state === "open" && (
                  <CheckInButton label={p.who === "You" ? "Check me in" : `Check in ${p.who}`} act={checkInAction.bind(null, code, p.signupId)} />
                )}
              </li>))}</ul>
            {view.state === "open" && waiting.length > 1 && (
              <CheckInButton label="Check everyone in" act={checkInAction.bind(null, code, "all")} wide />
            )}
            {view.state === "open" && view.people.every((p) => p.checkedIn) && <p className="volunteer-done">Everyone here is checked in. Thank you for helping!</p>}
          </Announcer>
        )}
        <p className="help"><Link className="link-line" href="/volunteer">Back to Volunteer</Link></p>
      </section>
    </main>
  );
}
