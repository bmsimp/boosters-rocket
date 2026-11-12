import { redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { matchReview } from "@/lib/parents/matches";
import { MatchRow, SwitchButton } from "../forms";
import { decideMatchAction, acceptStrongMatchesAction } from "../actions";

export const metadata = { title: "Review matches" };
export const dynamic = "force-dynamic";

/** The previous company's families beside their likely counterparts (spec §6). Only what `matchReview` returns reaches it. */
export default async function MatchesPage() {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const review = await matchReview();
  if (!review) redirect("/staff/settings/parents");
  const open = review.suggestions.filter((s) => s.decision !== "matched");
  const matched = review.suggestions.filter((s) => s.decision === "matched");
  const strong = open.filter((s) => s.strong && s.decision === null).length;
  const why = (s: (typeof open)[number]) => !s.suggested ? "No likely match found."
    : `Suggested: ${s.suggested.name} (${s.nameMatches ? "name matches" : "name differs"}, ${s.addressesMatched} of ${s.old.emails.length} addresses match).`;
  return (
    <main className="wrap single">
      <h1 className="page-title">Review matches</h1>
      <p className="lede">Each family from the previous QuickBooks company, beside the family it most likely is in the connected one. Accepting a match carries over decisions made about that family and remembers who was already welcomed. It never lets anyone sign in: that comes only from the connected company&apos;s roster. <a href="/staff/settings/parents">Back to Parent sign-ins</a></p>

      {strong > 0 && (
        <section className="box" aria-labelledby="mm-strong-h"><h2 id="mm-strong-h">Strong matches ({strong})</h2>
          <p>The name matches and every address that could sign in before is under the suggested family.</p>
          <SwitchButton label="Accept all strong matches" pendingLabel="Accepting…" act={acceptStrongMatchesAction} />
        </section>
      )}

      <section className="box" aria-labelledby="mm-open-h"><h2 id="mm-open-h">To decide ({open.length})</h2>
        {open.length === 0 ? <p>Every family has been matched.</p> : (
          <ul className="lines">{open.map((s) => (
            <li key={s.old.qboId}><div className="stack">
              <span className="what">{s.old.name}</span>
              <span className="when">{s.old.emails.length ? `Could sign in: ${s.old.emails.join(", ")}` : "Nobody could sign in"}{s.decision === "rejected" ? " · Marked as no match" : ""}</span>
              <span className="when">{why(s)}</span>
              <MatchRow oldId={s.old.qboId} suggested={s.suggested?.qboId ?? null} families={review.families} decide={decideMatchAction} />
            </div></li>))}</ul>
        )}
      </section>

      <section className="box" aria-labelledby="mm-done-h"><h2 id="mm-done-h">Matched</h2>
        {matched.length === 0 ? <p>None yet.</p> : (
          <ul>{matched.map((s) => <li key={s.old.qboId}>{s.old.name} is now {s.matchedTo?.name}</li>)}</ul>
        )}
      </section>
    </main>
  );
}
