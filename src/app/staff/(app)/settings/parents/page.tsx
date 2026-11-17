import { requireStaffPage } from "@/lib/guards";
import { accessPreview } from "@/lib/parents/switches";
import { matchReview } from "@/lib/parents/matches";
import { getPreviousCompany } from "@/lib/parents/company-change";
import { LocalTime } from "@/app/components/local-time";
import { SwitchButton } from "./forms";
import { StateWords } from "@/app/components/state-words";
import { BackToSettings } from "../back-to-settings";
import { setRequireStudentsAction, setReviewEmailsAction, deletePreviousCompanyAction } from "./actions";

export const metadata = { title: "Parent sign-ins" };
export const dynamic = "force-dynamic";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). Switching anything opens the steps. */
export default async function ParentSettingsPage() {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const [p, review, snapshot] = await Promise.all([accessPreview(), matchReview(), getPreviousCompany()]);
  // Of the previous company's snapshot, this page shows its date and how many families it holds, and nothing else.
  const previous = snapshot ? { at: snapshot.at, families: snapshot.families.length } : null;
  const s = p.settings;
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Parent sign-ins</h1>
      <p className="lede">Parents in QuickBooks can sign in to the portal with their email address and a code. Nobody is invited one by one: who can sign in follows the roster, once this is switched on. Only Admins can change this.</p>

      <section className="box" aria-labelledby="ps-status-h"><h2 id="ps-status-h">What is set</h2>
        <StateWords state={s.signin ? "done" : "todo"} words={s.signin ? "On: parents can sign in" : s.everEnabled ? "Switched off: nobody can sign in" : "Not switched on yet"} />
        <dl className="details">
          <dt>Parent sign-ins</dt><dd>{s.signin ? "On" : s.everEnabled ? "Switched off. Nobody can sign in." : "Not switched on yet"}</dd>
          <dt>Who can sign in</dt><dd>{s.signin ? `${n(p.people, "person", "people")}, to ${n(p.families, "family", "families")}` : "Nobody yet"}</dd>
          <dt>Welcome emails</dt><dd>{s.welcome ? "On: each new person is emailed once" : "Off: nobody is emailed"}</dd>
          <dt>Waiting for staff</dt><dd>{n(p.held.filter((h) => h.pending).length, "address", "addresses")} to review</dd>
        </dl>
        <p><a className="btn" href="/staff/settings/parents/setup">{s.everEnabled ? "Change" : "Set up"}</a></p>
      </section>

      <section className="box" aria-labelledby="ps-options-h"><h2 id="ps-options-h">Options</h2>
        <h3>Families with no active student</h3>
        {p.students.offered ? (
          <>
            <p>{s.requireActiveStudents ? "On: a family with no active student in QuickBooks can't sign in." : `Off: students don't affect who can sign in. Switching this on would close ${n(p.students.families, "family", "families")} (${n(p.students.people, "person", "people")}) now.`}</p>
            <SwitchButton quiet label={s.requireActiveStudents ? "Let those families sign in" : "Require an active student"} pendingLabel="Saving…" act={setRequireStudentsAction.bind(null, !s.requireActiveStudents)} />
          </>
        ) : <p>Not available: the membership shape doesn&apos;t say which customers are students.</p>}
        <h3>Emails to staff</h3>
        <p>{s.reviewEmails ? "On: people who can review held addresses get one email when there is something new, at most once a day." : "Off: nobody is emailed. The notice on the staff home still shows."}</p>
        <SwitchButton quiet label={s.reviewEmails ? "Stop these emails" : "Send these emails"} pendingLabel="Saving…" act={setReviewEmailsAction.bind(null, !s.reviewEmails)} />
      </section>

      {previous && (
        <section className="box" aria-labelledby="ps-prev-h"><h2 id="ps-prev-h">The previous QuickBooks company</h2>
          <p>A different QuickBooks company was connected <LocalTime iso={previous.at} />. All parent access from the old company ended then. The portal kept a list of the old company&apos;s {n(previous.families, "family", "families")} and who could sign in to them, so decisions made there can be carried over.</p>
          {review ? <p><a className="btn" href="/staff/settings/parents/matches">Review matches</a></p>
            : <p>The matches can be reviewed once the new company&apos;s roster has been read and a membership shape chosen.</p>}
          <details><summary>Delete this list</summary>
            <p>It is deleted by itself 90 days after the switch. Matches already accepted are kept.</p>
            <SwitchButton quiet label="Delete the list now" pendingLabel="Deleting…" act={deletePreviousCompanyAction} />
          </details>
        </section>
      )}
    </main>
  );
}
