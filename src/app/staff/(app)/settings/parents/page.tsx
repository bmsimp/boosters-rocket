import { Fragment } from "react";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { RESET_PERMISSION, oldAddressPasskeys } from "@/lib/parents/signin-reset";
import { OLD_PASSKEYS_COPY as OLD } from "@/lib/parents/old-passkeys-copy";
import { readStoredSettings, type SigninLevel } from "@/lib/parents/settings";
import { closedForNoStudents, missingForSignins, setupMailsToOwe, signinCounts, studentsEffect } from "@/lib/parents/switches";
import { Notice } from "@/app/components/notice";
import { SwitchButton } from "./forms";
import { StateWords } from "@/app/components/state-words";
import { SettingsHeader } from "../back-to-settings";
import { oweSetupMailsAction, removeOldAddressPasskeysAction, setRequireStudentsAction } from "./actions";
import { sampleChoosePassword } from "@/lib/parents/welcome";

export const metadata = { title: "Parent sign-ins" };
export const dynamic = "force-dynamic";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** The club's sign-in level in words (slice SI-10b), or what an unreadable stored value means. */
const LEVEL_WORDS: Record<SigninLevel | "unknown", string> = {
  standard: "Standard: a password, and on a phone or computer the portal doesn't know yet, a code we email, or the guardian's own passkey or authenticator app",
  strict: "Strict: a password and a passkey or an authenticator app, every time. An emailed code never signs anyone in.",
  unknown: "Not known: the saved sign-in settings can't be read. Choose Standard or Strict under Configure, step 3.",
};

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). Switching anything opens the steps. */
export default async function ParentSettingsPage() {
  const ctx = await requireStaffPage("Settings.Parents.ReadWrite");
  // Passkeys from an earlier address (slice SI-9b): counted and offered only to a holder of the reset's permission.
  const mayRemoveOld = can(ctx.effective, RESET_PERMISSION);
  const [{ settings: s, level }, counts, students, missing, closedEarlier, noPassword, old] = await Promise.all([readStoredSettings(), signinCounts(), studentsEffect(), missingForSignins(), closedForNoStudents(), setupMailsToOwe(),
    mayRemoveOld ? oldAddressPasskeys() : null]);
  // The press's mail, as the worker writes it, for the Admin to read before pressing.
  const sample = s.signin && s.welcome && noPassword > 0 ? await sampleChoosePassword("parent@example.org") : null;
  return (
    <main className="wrap single">
      <SettingsHeader effective={ctx.effective} title="Parent sign-ins" lede={level === "strict"
        ? <>Parents sign in to the portal with their email address and a password, which they choose from a link the portal emails them, and then a passkey or an authenticator app, every time. Who can sign in is the portal&apos;s own list of each family&apos;s guardians: a change made in QuickBooks no longer gives anyone a sign-in or ends one. Only Admins can change this.</>
        : <>Parents sign in to the portal with their email address and a password, which they choose from a link the portal emails them; on a phone or computer the portal doesn&apos;t know yet, it emails them a code too. Who can sign in is the portal&apos;s own list of each family&apos;s guardians: a change made in QuickBooks no longer gives anyone a sign-in or ends one. Only Admins can change this.</>} />

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
        {/* Configure, whatever the state (the owner's of 2026-11-27): the sentence says the state, the button opens the steps. */}
        <p>{level === null ? "The sign-in level can't be read. Configure to choose Standard or Strict."
          : !s.signin ? "Off. Configure to switch parent sign-ins on."
          : "On. Configure to switch sign-ins or welcome emails, or to change the sign-in level."}</p>
        <p><a className="btn" href="/staff/settings/parents/setup">Configure</a></p>
      </section>

      {/* Passkeys made at an address other than the portal's now (the sign-in release, slice SI-9b): they no longer
          work, yet the portal still asks their holders for them. Drawn only while there are any, for a holder of the
          reset's permission; the press sends the count shown, which the work checks again under its locks. */}
      {old && old.passkeys > 0 && (
        <section className="box" aria-labelledby="ps-old-passkeys-h"><h2 id="ps-old-passkeys-h">{OLD.heading}</h2>
          <p>{OLD.lede(old.origin, old.passkeys, old.people)}</p>
          <dl className="details">
            {old.byOrigin.map((g) => <Fragment key={g.origin ?? ""}><dt>{g.origin ?? OLD.unrecorded}</dt><dd>{OLD.count(g.passkeys)}</dd></Fragment>)}
          </dl>
          <Notice tone="warning" live="none">{OLD.warning(level === "strict", old.leftWithNoFactor)}</Notice>
          <p>{OLD.makeSure(old.origin)}</p>
          <SwitchButton label={OLD.button(old.passkeys)} pendingLabel={OLD.pending} act={removeOldAddressPasskeysAction.bind(null, old.passkeys)} />
        </section>
      )}

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
        <p>{s.requireActiveStudents ? "On: a family with no active student can't sign in. Nobody's sign-in is ended for it: they can sign in again once the family has an active student, or this is switched off."
          : `Off: students don't affect who can sign in. Switching this on would stop ${n(students.people, "person", "people")} signing in, in ${n(students.families, "family", "families")} with no active student, until the family has one.`}</p>
        {closedEarlier > 0 && <p>{`${n(closedEarlier, "sign-in", "sign-ins")} an earlier version of the portal ended for this ${closedEarlier === 1 ? "stays" : "stay"} ended, whatever this is set to and whatever students the family has.`}</p>}
        <SwitchButton quiet label={s.requireActiveStudents ? "Let those families sign in" : "Require an active student"} pendingLabel="Saving…" act={setRequireStudentsAction.bind(null, !s.requireActiveStudents)} />
      </section>
    </main>
  );
}
