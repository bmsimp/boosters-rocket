import { requireStaffPage } from "@/lib/guards";
import { readStoredSettings, type SigninLevel } from "@/lib/parents/settings";
import { closedForNoStudents, missingForSignins, NO_STUDENTS_IN_SHAPE, setupMailsToOwe, signinCounts, STUDENTS_RULE_NOT_IN_USE, studentsEffect, studentsRuleUsable } from "@/lib/parents/switches";
import { Notice } from "@/app/components/notice";
import { SwitchButton } from "./forms";
import { StateWords } from "@/app/components/state-words";
import { BackToSettings } from "../back-to-settings";
import { oweSetupMailsAction, setRequireStudentsAction } from "./actions";
import { sampleChoosePassword } from "@/lib/parents/welcome";

export const metadata = { title: "Parent sign-ins" };
export const dynamic = "force-dynamic";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** The club's sign-in level in words (slice SI-10b), or what an unreadable stored value means. */
const LEVEL_WORDS: Record<SigninLevel | "unknown", string> = {
  standard: "Standard: a password, and on a phone or computer the portal doesn't know yet, a code we email, or the guardian's own passkey or authenticator app",
  strict: "Strict: a password and a passkey or an authenticator app, every time. An emailed code never signs anyone in.",
  unknown: "Not known: the saved sign-in settings can't be read. Choose Standard or Strict under Change, step 3.",
};

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). Switching anything opens the steps. */
export default async function ParentSettingsPage() {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const [{ settings: s, level }, counts, students, missing, usable, closedEarlier, noPassword] = await Promise.all([readStoredSettings(), signinCounts(), studentsEffect(), missingForSignins(), studentsRuleUsable(), closedForNoStudents(), setupMailsToOwe()]);
  // The press's mail, as the worker writes it, for the Admin to read before pressing.
  const sample = s.signin && s.welcome && noPassword > 0 ? await sampleChoosePassword("parent@example.org") : null;
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Parent sign-ins</h1>
      {level === "strict"
        ? <p className="lede">Parents sign in to the portal with their email address and a password, which they choose from a link the portal emails them, and then a passkey or an authenticator app, every time. Who can sign in is the portal&apos;s own list of each family&apos;s guardians: a change made in QuickBooks no longer gives anyone a sign-in or ends one. Only Admins can change this.</p>
        : <p className="lede">Parents sign in to the portal with their email address and a password, which they choose from a link the portal emails them; on a phone or computer the portal doesn&apos;t know yet, it emails them a code too. Who can sign in is the portal&apos;s own list of each family&apos;s guardians: a change made in QuickBooks no longer gives anyone a sign-in or ends one. Only Admins can change this.</p>}

      <section className="box" aria-labelledby="ps-status-h"><h2 id="ps-status-h">What is set</h2>
        <StateWords state={s.signin ? "done" : "todo"} words={s.signin ? "On: parents can sign in" : "Off: nobody can sign in"} />
        <dl className="details">
          <dt>Parent sign-ins</dt><dd>{s.signin ? "On" : "Off. Nobody can sign in, not even a guardian staff have added."}</dd>
          <dt>Who can sign in</dt><dd>{s.signin ? `${n(counts.people, "person", "people")}, to ${n(counts.families, "family", "families")}` : "Nobody yet"}</dd>
          <dt>Welcome emails</dt><dd>{s.welcome ? "On: everyone who could sign in when this was switched on is emailed once, and so is each guardian staff add or reinstate since" : "Off: nobody is emailed"}</dd>
          <dt>Sign-in level</dt><dd>{LEVEL_WORDS[level ?? "unknown"]}</dd>
        </dl>
        {!s.signin && (missing.length > 0
          ? <Notice tone="warning" live="none">Before sign-ins can be switched on:<ul className="notice-list">{missing.map((m) => <li key={m}>{m}</li>)}</ul></Notice>
          : <Notice tone="info" live="none">Everything sign-ins need is ready: outgoing mail works.</Notice>)}
        {/* "Change" too while the level can't be read (slice SI-10b): the level's words send the Admin there by that name. */}
        <p><a className="btn" href="/staff/settings/parents/setup">{s.signin || level === null ? "Change" : "Set up"}</a></p>
      </section>

      {/* People welcomed before parents signed in with a password have none, and nothing else emails them a link
          (the sign-in release, slice SI-4). Shown only while an email can go and there is anyone to email. */}
      {sample && (
        <section className="box" aria-labelledby="ps-setup-h"><h2 id="ps-setup-h">Passwords not chosen yet</h2>
          <p>{`${n(noPassword, "person", "people")} can sign in and ${noPassword === 1 ? "hasn't" : "haven't"} chosen a password, with no link to choose one that still works (someone emailed a link is counted again only once it runs out unused). Each can be emailed a link: anyone never welcomed gets the welcome, and anyone welcomed before gets the email below. ${level === "strict" ? "Once they've chosen a password, the portal asks them to add a passkey or an authenticator app before they see anything else." : "A phone or computer they are signed in on now stays signed in."} They go out a few each minute.`}</p>
          <h3>The email to someone welcomed before</h3>
          <p>Subject: {sample.subject}</p>
          <pre className="email-sample">{sample.text}</pre>
          <SwitchButton label={`Email a set-up link to everyone who can sign in and hasn't chosen a password (${noPassword})`} pendingLabel="Queueing…" act={oweSetupMailsAction} />
        </section>
      )}

      <section className="box" aria-labelledby="ps-options-h"><h2 id="ps-options-h">Options</h2>
        <h3>Families with no active student</h3>
        {s.requireActiveStudents && !usable
          ? <Notice tone="info" live="none">{STUDENTS_RULE_NOT_IN_USE}</Notice>
          : <p>{s.requireActiveStudents ? "On: a family with no active student can't sign in. Nobody's sign-in is ended for it: they can sign in again once the family has an active student, or this is switched off."
            : !usable ? `Off. ${NO_STUDENTS_IN_SHAPE}`
            : `Off: students don't affect who can sign in. Switching this on would stop ${n(students.people, "person", "people")} signing in, in ${n(students.families, "family", "families")} with no active student, until the family has one.`}</p>}
        {closedEarlier > 0 && <p>{`${n(closedEarlier, "sign-in", "sign-ins")} an earlier version of the portal ended for this ${closedEarlier === 1 ? "stays" : "stay"} ended, whatever this is set to and whatever students the family has.`}</p>}
        {(s.requireActiveStudents || usable) && <SwitchButton quiet label={s.requireActiveStudents ? "Let those families sign in" : "Require an active student"} pendingLabel="Saving…" act={setRequireStudentsAction.bind(null, !s.requireActiveStudents)} />}
      </section>
    </main>
  );
}
