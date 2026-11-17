import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { heldReview, listPeople, type PersonRow } from "@/lib/parents/directory";
import { getParentSettings } from "@/lib/parents/settings";
import { LocalTime } from "@/app/components/local-time";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { StateWords } from "@/app/components/state-words";
import { HoldForm, NoteAction } from "./forms";
import { decideHoldAction, reverseHoldAction } from "./actions";

export const metadata = { title: "Parents" };
export const dynamic = "force-dynamic";

/** Everyone the portal knows, a row each: who, their address, when they last signed in, their welcome, and each family. */
function People({ people, typed }: { people: PersonRow[]; typed: string }) {
  return (
    <DataTable caption={typed ? <>{people.length} matching &quot;{typed}&quot;</> : "Everyone, by name"} rows={people} rowKey={(p) => p.parentId} columns={[
      { key: "name", header: "Person", rowHeader: true, sorted: "ascending", cell: (p) => (
        <><Link href={`/staff/parents/${p.parentId}`}>{p.name}</Link>{p.blocked && <StateWords state="waived" words="Blocked" />}</>) },
      { key: "email", header: "Email", cell: (p) => p.email },
      { key: "signin", header: "Last signed in", cell: (p) => (p.lastSigninAt ? <LocalTime iso={p.lastSigninAt} /> : "Never") },
      { key: "welcome", header: "Welcome email", cell: (p) => (p.welcomedAt ? <>Sent <LocalTime iso={p.welcomedAt} /></> : "Not sent yet") },
      // Family names are text here, never links: a previous company's row carries that company's ID.
      { key: "families", header: "Families", cell: (p) => (p.families.length === 0 ? "No families"
        : p.families.map((f, i) => <span key={`${f.previousCompany ? "old" : "now"}|${f.familyQboId}|${i}`} className="t-line">{f.familyName}: {f.words}</span>)) },
    ]} />
  );
}

export default async function ParentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Parents.ReadWrite");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : "").slice(0, 100);
  const [review, people, settings] = await Promise.all([heldReview(), listPeople(typed), getParentSettings()]);
  return (
    <main className="wrap single">
      <h1 className="page-title">Parents</h1>
      <p className="lede">Who can sign in to the portal, and why someone can&apos;t. People come from QuickBooks. A missing parent is added, and a name changed, from the family&apos;s page under Roster, by staff who may change the roster; it is sent to QuickBooks first. Email addresses are changed in QuickBooks, not here, followed by Refresh now on the roster.</p>
      {!settings.signin && <Notice tone="warning">{settings.everEnabled ? "Parent sign-ins are switched off, so nobody can sign in right now." : "Parent sign-ins haven't been switched on yet. An Admin does that under Parent sign-ins."}</Notice>}

      <section className="box" aria-labelledby="review-h"><h2 id="review-h">To review ({review.waiting.length})</h2>
        {review.waiting.length === 0 ? <Notice tone="done" live="none">Nothing is waiting.</Notice> : (
          <>
            <p>Each address below is under more than one family in QuickBooks. Nobody at that address can sign in to the families marked held until you say whether it is one person. If it is a copying mistake, choose Not the same person and have the records corrected in QuickBooks.</p>
            <ul className="review-items">{review.waiting.map((h) => (
              <li key={h.email} className="review-item">
                <p className="review-address">{h.email}</p>
                <dl className="details">
                  <dt>On records named</dt><dd>{h.names.join(", ")}</dd>
                  <dt>Families</dt>
                  <dd><ul className="review-families">{h.families.map((f) => (
                    <li key={f.qboId}>{f.name} <StateWords state={f.held ? "todo" : "done"} words={f.held ? "Held" : "Already approved"} /></li>))}</ul></dd>
                </dl>
                <HoldForm email={h.email} familyQboIds={h.families.map((f) => f.qboId)} decide={decideHoldAction} />
              </li>))}</ul>
          </>
        )}
      </section>

      {review.decided.length > 0 && (
        <section className="box" aria-labelledby="decided-h"><h2 id="decided-h">Decided</h2>
          <ul className="review-items">{review.decided.map((d) => (
            <li key={d.email} className="review-item">
              <p className="review-address">{d.email}</p>
              <p>
                {d.approved.length ? `Same person in ${d.approved.join(", ")}. ` : ""}{d.rejected.length ? `Not the same person in ${d.rejected.join(", ")}. ` : ""}
                {d.decidedBy ? `Decided by ${d.decidedBy}` : "Decided"}{d.decidedAt ? <> <LocalTime iso={d.decidedAt} /></> : null}{d.note ? `: ${d.note}` : "."}
              </p>
              <details className="more"><summary>Reverse this decision</summary>
                <p>The address is held again for every family, and anyone it let in is signed out of those families.</p>
                <NoteAction label="Reverse" field="Why? (staff only)" pendingLabel="Reversing…" act={reverseHoldAction.bind(null, d.email)} />
              </details>
            </li>))}</ul>
        </section>
      )}

      <section className="box" aria-labelledby="people-h"><h2 id="people-h">People</h2>
        <form method="get" role="search" className="stack">
          <label className="field"><span>Find a person by name or email</span><input name="q" type="search" defaultValue={typed} autoComplete="off" /></label>
          <button className="btn btn-line">Find</button>
        </form>
        {people.length === 0 ? <Notice tone="info">{typed ? "Nobody matches." : "Nobody yet."}</Notice> : <People people={people} typed={typed} />}
      </section>
    </main>
  );
}
