import { requireStaffPage } from "@/lib/guards";
import { getParentSettings } from "@/lib/parents/settings";
import { missingForSignins, signinCounts, studentsEffect } from "@/lib/parents/switches";
import { Notice } from "@/app/components/notice";
import { SwitchButton } from "./forms";
import { StateWords } from "@/app/components/state-words";
import { BackToSettings } from "../back-to-settings";
import { setRequireStudentsAction } from "./actions";

export const metadata = { title: "Parent sign-ins" };
export const dynamic = "force-dynamic";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). Switching anything opens the steps. */
export default async function ParentSettingsPage() {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const [s, counts, students, missing] = await Promise.all([getParentSettings(), signinCounts(), studentsEffect(), missingForSignins()]);
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Parent sign-ins</h1>
      <p className="lede">Parents sign in to the portal with their email address and a code. Who can sign in is the portal&apos;s own list of each family&apos;s guardians: a change made in QuickBooks no longer gives anyone a sign-in or ends one. Only Admins can change this.</p>

      <section className="box" aria-labelledby="ps-status-h"><h2 id="ps-status-h">What is set</h2>
        <StateWords state={s.signin ? "done" : "todo"} words={s.signin ? "On: parents can sign in" : s.everEnabled ? "Switched off: nobody can sign in" : "Not switched on yet"} />
        <dl className="details">
          <dt>Parent sign-ins</dt><dd>{s.signin ? "On" : s.everEnabled ? "Switched off. Nobody can sign in." : "Not switched on yet"}</dd>
          <dt>Who can sign in</dt><dd>{s.signin ? `${n(counts.people, "person", "people")}, to ${n(counts.families, "family", "families")}` : "Nobody yet"}</dd>
          <dt>Welcome emails</dt><dd>{s.welcome ? "On: each new person is emailed once" : "Off: nobody is emailed"}</dd>
        </dl>
        {!s.signin && (missing.length > 0
          ? <Notice tone="warning" live="none">Before sign-ins can be switched on:<ul className="notice-list">{missing.map((m) => <li key={m}>{m}</li>)}</ul></Notice>
          : <Notice tone="info" live="none">Everything sign-ins need is ready: outgoing mail works.</Notice>)}
        <p><a className="btn" href="/staff/settings/parents/setup">{s.everEnabled ? "Change" : "Set up"}</a></p>
      </section>

      <section className="box" aria-labelledby="ps-options-h"><h2 id="ps-options-h">Options</h2>
        <h3>Families with no active student</h3>
        <p>{s.requireActiveStudents ? "On: a family with no active student can't sign in. Nobody's sign-in is ended for it: they can sign in again once the family has an active student, or this is switched off."
          : `Off: students don't affect who can sign in. Switching this on would stop ${n(students.people, "person", "people")} signing in, in ${n(students.families, "family", "families")} with no active student, until the family has one.`}</p>
        <SwitchButton quiet label={s.requireActiveStudents ? "Let those families sign in" : "Require an active student"} pendingLabel="Saving…" act={setRequireStudentsAction.bind(null, !s.requireActiveStudents)} />
      </section>
    </main>
  );
}
