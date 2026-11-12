import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { heldReview, listPeople } from "@/lib/parents/directory";
import { getParentSettings } from "@/lib/parents/settings";
import { LocalTime } from "@/app/components/local-time";
import { HoldForm, NoteAction } from "./forms";
import { decideHoldAction, reverseHoldAction } from "./actions";

export const metadata = { title: "Parents" };
export const dynamic = "force-dynamic";

export default async function ParentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Parents.ReadWrite");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : "").slice(0, 100);
  const [review, people, settings] = await Promise.all([heldReview(), listPeople(typed), getParentSettings()]);
  return (
    <main className="wrap single">
      <h1 className="page-title">Parents</h1>
      <p className="lede">Who can sign in to the portal, and why someone can&apos;t. People come from QuickBooks. Names and email addresses are changed in QuickBooks, not here; a missing parent is added in QuickBooks, then the roster is refreshed.</p>
      {!settings.signin && <p role="status">{settings.everEnabled ? "Parent sign-ins are switched off, so nobody can sign in right now." : "Parent sign-ins haven't been switched on yet. An Admin does that under Parent sign-ins."}</p>}

      <section className="box" aria-labelledby="review-h"><h2 id="review-h">To review ({review.waiting.length})</h2>
        {review.waiting.length === 0 ? <p>Nothing is waiting.</p> : (
          <>
            <p>Each address below is under more than one family in QuickBooks. Nobody at that address can sign in to the families marked held until you say whether it is one person. If it is a copying mistake, choose Not the same person and have the records corrected in QuickBooks.</p>
            <ul className="lines">{review.waiting.map((h) => (
              <li key={h.email}><div className="stack">
                <span className="what">{h.email}</span>
                <span className="when">On records named: {h.names.join(", ")}</span>
                <ul>{h.families.map((f) => <li key={f.qboId}>{f.name}{f.held ? " (held)" : " (already approved)"}</li>)}</ul>
                <HoldForm email={h.email} familyQboIds={h.families.map((f) => f.qboId)} decide={decideHoldAction} />
              </div></li>))}</ul>
          </>
        )}
      </section>

      {review.decided.length > 0 && (
        <section className="box" aria-labelledby="decided-h"><h2 id="decided-h">Decided</h2>
          <ul className="lines">{review.decided.map((d) => (
            <li key={d.email}><div className="stack">
              <span className="what">{d.email}</span>
              <span className="when">
                {d.approved.length ? `Same person in ${d.approved.join(", ")}. ` : ""}{d.rejected.length ? `Not the same person in ${d.rejected.join(", ")}. ` : ""}
                {d.decidedBy ? `Decided by ${d.decidedBy}` : "Decided"}{d.decidedAt ? <> <LocalTime iso={d.decidedAt} /></> : null}{d.note ? `: ${d.note}` : "."}
              </span>
              <details><summary>Reverse this decision</summary>
                <p>The address is held again for every family, and anyone it let in is signed out of those families.</p>
                <NoteAction label="Reverse" field="Why? (staff only)" pendingLabel="Reversing…" act={reverseHoldAction.bind(null, d.email)} />
              </details>
            </div></li>))}</ul>
        </section>
      )}

      <section className="box" aria-labelledby="people-h"><h2 id="people-h">People</h2>
        <form method="get" role="search" className="stack">
          <label className="field"><span>Find a person by name or email</span><input name="q" type="search" defaultValue={typed} autoComplete="off" /></label>
          <button className="btn btn-line">Find</button>
        </form>
        {people.length === 0 ? <p>{typed ? "Nobody matches." : "Nobody yet."}</p> : (
          <ul className="lines">{people.map((p) => (
            <li key={p.parentId}><div>
              <Link className="what" href={`/staff/parents/${p.parentId}`}>{p.name}</Link>
              <span className="when">{p.email}{p.blocked ? " · Blocked" : ""}</span>
              {/* Family names are text here, never links: a previous company's row carries that company's ID. */}
              <span className="when">{p.families.map((f) => `${f.familyName}: ${f.words}`).join(" · ") || "No families"}</span>
            </div></li>))}</ul>
        )}
      </section>
    </main>
  );
}
