import { Notice } from "@/app/components/notice";
import { requireStaffPage } from "@/lib/guards";
import { missingForSignins, signinCounts } from "@/lib/parents/switches";
import { getParentSettings } from "@/lib/parents/settings";
import { welcomeEmailFor } from "@/lib/parents/welcome";
import { SwitchButton } from "../forms";
import { setSigninsAction, setWelcomeAction } from "../actions";

export const metadata = { title: "Set up parent sign-ins" };
export const dynamic = "force-dynamic";

type Step = "signins" | "welcome";
const STEPS: { step: Step; label: string }[] = [{ step: "signins", label: "1. Parent sign-ins" }, { step: "welcome", label: "2. Welcome emails" }];
const SETUP = "/staff/settings/parents/setup";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The two steps (spec §3). A pressed switch re-renders the page without its button, and so without that button's
 * message: each step therefore says the state it is in, in words, whatever was pressed. Who can sign in is the portal's
 * own guardian rows, counted as the gate counts them (src/lib/parents/sessions.ts): switching on opens and closes none.
 */
export default async function ParentSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const sp = await searchParams;
  const asked = STEPS.find((s) => s.step === (typeof sp.step === "string" ? sp.step : ""))?.step;
  const [settings, counts, missing] = await Promise.all([getParentSettings(), signinCounts(), missingForSignins()]);
  const step: Step = asked ?? (settings.signin ? "welcome" : "signins");
  const sample = step === "welcome" ? await welcomeEmailFor("parent@example.org") : null;
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
      <h1 className="page-title">Set up parent sign-ins</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}><a href={`${SETUP}?step=${s.step}`}>{s.label}</a></li>)}</ol>

      {step === "signins" && (
        <section className="box" aria-labelledby="psi-h"><h2 id="psi-h">Step 1: Parent sign-ins</h2>
          {!settings.signin && <Notice tone="info">Parent sign-ins are off. Nobody can sign in.</Notice>}
          {settings.signin ? (
            <>
              <Notice tone="done" live="none">Parent sign-ins are on. {n(counts.people, "person", "people")} can sign in, to {n(counts.families, "family", "families")}.</Notice>
              <details><summary>Switch parent sign-ins off</summary>
                <p>Every parent is signed out at once and nobody can sign in until this is switched on again. Welcome emails are switched off too. Nothing is deleted.</p>
                <SwitchButton quiet label="Switch parent sign-ins off" pendingLabel="Switching off…" act={setSigninsAction.bind(null, false)} />
              </details>
            </>
          ) : missing.length > 0 ? (
            <Notice tone="warning">Not yet:<ul className="notice-list">{missing.map((m) => <li key={m}>{m}</li>)}</ul></Notice>
          ) : (
            <>
              <p>Switching on lets {n(counts.people, "person", "people")} sign in, to {n(counts.families, "family", "families")}: the guardians the portal holds for each family. No email is sent: welcome emails are step 2.</p>
              <SwitchButton label="Switch parent sign-ins on" pendingLabel="Switching on…" act={setSigninsAction.bind(null, true)} />
            </>
          )}
          <p className="box-foot"><a className="link-line" href={`${SETUP}?step=welcome`}>Next: welcome emails</a> · <a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "welcome" && sample && (
        <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Step 2: Welcome emails</h2>
          <Notice tone="info">{settings.welcome
            ? "Welcome emails are on. Everyone who could sign in when they were switched on is emailed once, and so is a guardian staff add or reinstate later, once they can sign in. Nobody else is emailed later by themselves: a family that gets its first active student, or becomes active again, sends no welcome to the guardians it had."
            : "Welcome emails are off. Nobody is emailed."}</Notice>
          {!settings.welcome && <p><b>{n(counts.welcomeNow, "person", "people")} would be emailed now.</b> Someone who can only sign in later isn&apos;t emailed by themselves, but a guardian staff add or reinstate while welcome emails are on is emailed once they can sign in. They go out a few each minute.</p>}
          <h3>The email</h3>
          <p>Subject: {sample.subject}</p>
          <pre className="email-sample">{sample.text}</pre>
          {settings.welcome ? <SwitchButton quiet label="Switch welcome emails off" pendingLabel="Switching off…" act={setWelcomeAction.bind(null, false)} />
            : !settings.signin ? <Notice tone="info">Switch parent sign-ins on first (step 1).</Notice>
            : <SwitchButton label="Switch welcome emails on" pendingLabel="Switching on…" act={setWelcomeAction.bind(null, true)} />}
          <p className="box-foot"><a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}
    </main>
  );
}
