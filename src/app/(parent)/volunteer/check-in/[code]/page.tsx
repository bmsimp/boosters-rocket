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
import { Card, List, ListRow, Notice, PageHeader } from "../../../../components/ui";

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
    return <main className="wrap single"><PageHeader title="Check in" /><NotSetUpBox treasurerEmail={club.treasurerEmail} /></main>;
  }
  const view = await loadCheckInForMe(ctx, code);
  if (!view) notFound();
  const closed = closedWords(view);
  const waiting = view.people.filter((p) => !p.checkedIn && !p.corrected);
  return (
    <main className="wrap single volunteer-page">
      <PageHeader title="Check in" back={{ href: "/volunteer", label: "Back to Volunteer" }}
        lede={<>{view.event}{view.role ? `, ${view.role}` : ""}: {view.dateWords}, {view.timeWords} · {view.location}</>} />

      <Card title={family.name} titleId="checkin-h">
        {view.people.length === 0 ? (
          <p>Nobody in your family is signed up for this shift. Want to help? Find a shift with a free place on the <Link href="/volunteer">Volunteer page</Link>.</p>
        ) : (
          <Announcer>
            {closed && <Notice tone="info" live="none">{closed}</Notice>}
            <List>
              {view.people.map((p) => (
                // Done once checked in; neutral until then, or once the club updated it.
                <ListRow key={p.signupId} title={p.who === "You" ? "You" : p.who}
                  status={p.checkedIn ? { tone: "done", words: "Checked in" } : { tone: "neutral", words: p.corrected ? "Updated by the club" : "Not checked in yet" }}
                  detail={(p.corrected || (!p.checkedIn && view.state === "open")) && <>
                    {p.corrected && <p className="help">The club has updated this check-in. If something isn&apos;t right, please talk to {view.contact}.</p>}
                    {!p.checkedIn && !p.corrected && view.state === "open" && (
                      <CheckInButton label={p.who === "You" ? "Check me in" : `Check in ${p.who}`} act={checkInAction.bind(null, code, p.signupId)}
                        variant={waiting.length > 1 ? "secondary" : "primary"} />
                    )}
                  </>} />
              ))}
            </List>
            {view.state === "open" && waiting.length > 1 && (
              <CheckInButton label="Check everyone in" act={checkInAction.bind(null, code, "all")} wide />
            )}
            {view.state === "open" && view.people.every((p) => p.checkedIn) && <Notice tone="done" live="none">Everyone here is checked in. Thank you for helping!</Notice>}
          </Announcer>
        )}
      </Card>
    </main>
  );
}
