import { requireStaffPage } from "@/lib/guards";
import { accessPreview, missingForSignins } from "@/lib/parents/switches";
import { getParentSettings } from "@/lib/parents/settings";
import { welcomeEmailFor } from "@/lib/parents/welcome";
import { SwitchButton } from "../forms";
import { setSigninsAction, setWelcomeAction } from "../actions";

export const metadata = { title: "Set up parent sign-ins" };
export const dynamic = "force-dynamic";

type Step = "preview" | "signins" | "welcome";
const STEPS: { step: Step; label: string }[] = [{ step: "preview", label: "1. Clean-up preview" }, { step: "signins", label: "2. Parent sign-ins" }, { step: "welcome", label: "3. Welcome emails" }];
const SETUP = "/staff/settings/parents/setup";
const ENDING_BUSY = "This list is being worked out while the roster refreshes. Reload the page in a minute.";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The three steps (spec §3). A pressed switch re-renders the page without its button, and so without that button's
 * message: each step therefore says the state it is in, in words, whatever was pressed.
 */
export default async function ParentSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const sp = await searchParams;
  const asked = STEPS.find((s) => s.step === (typeof sp.step === "string" ? sp.step : ""))?.step;
  const on = (await getParentSettings()).signin;
  const step: Step = asked ?? (on ? "welcome" : "preview");
  // The dry run behind "Sign-ins that would end" runs only on the steps that show it, and only while sign-ins are off.
  const [p, missing] = await Promise.all([accessPreview({ ending: step !== "welcome" && !on }), missingForSignins()]);
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).join(", ");
  const sample = step === "welcome" ? await welcomeEmailFor("parent@example.org") : null;
  const switchedOff = p.settings.everEnabled && !p.settings.signin;
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
      <h1 className="page-title">Set up parent sign-ins</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}><a href={`${SETUP}?step=${s.step}`}>{s.label}</a></li>)}</ol>

      {step === "preview" && (
        <section className="box" aria-labelledby="pp-h"><h2 id="pp-h">Step 1: What would happen</h2>
          {missing.length > 0 && <ul role="status">{missing.map((m) => <li key={m}>{m}</li>)}</ul>}
          {p.ready.shape && (
            <>
              <p><b>{n(p.people, "person", "people")} would be able to sign in, to {n(p.families, "family", "families")}.</b></p>
              <p>Nothing below stops you switching on. The people listed just can&apos;t sign in until it is fixed. Fix records in QuickBooks, choose Refresh now on the Roster, and open this page again.</p>
              <h3>Addresses under more than one family ({p.held.length})</h3>
              {p.held.length === 0 ? <p>None.</p> : <ul>{p.held.map((h) => <li key={h.email}>{h.email}: {h.families.map((f) => f.name).join(", ")}</li>)}</ul>}
              <p className="hint">These are held until someone with access to Parents says whether each is one person.</p>
              <h3>No email address ({p.noEmail.length})</h3><p>{p.noEmail.length ? names(p.noEmail) : "None."}</p>
              <h3>More than one address on a person&apos;s record ({p.manyAddresses.length})</h3><p>{p.manyAddresses.length ? names(p.manyAddresses) : "None."}</p>
              <h3>Nobody could sign in ({p.noSignin.length})</h3><p>{p.noSignin.length ? names(p.noSignin) : "None."}</p>
              {/* Worked out only while sign-ins are off: once they are on, the reconcile keeps sign-ins in line by itself. */}
              {!on && (p.endingUnknown ? (
                <><h3>Sign-ins that would end</h3><p role="status">{ENDING_BUSY}</p></>
              ) : (
                <><h3>Sign-ins that would end ({p.ending.length})</h3>
                  {p.ending.length === 0 ? <p>None.</p> : <ul>{p.ending.map((e) => <li key={`${e.email}|${e.familyQboId}`}>{e.name} ({e.email})</li>)}</ul>}
                  <p className="hint">QuickBooks no longer backs these, so they stop working when sign-ins are switched on.</p></>
              ))}
            </>
          )}
          <p className="box-foot"><a className="btn" href={`${SETUP}?step=signins`}>Next: parent sign-ins</a> <a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "signins" && (
        <section className="box" aria-labelledby="psi-h"><h2 id="psi-h">Step 2: Parent sign-ins</h2>
          {switchedOff && <p role="status">Parent sign-ins are off. Nobody can sign in.</p>}
          {p.settings.signin ? (
            <>
              <p>Parent sign-ins are on. {n(p.people, "person", "people")} can sign in, to {n(p.families, "family", "families")}.</p>
              <details><summary>Switch parent sign-ins off</summary>
                <p>Every parent is signed out at once and nobody can sign in until this is switched on again. Welcome emails are switched off too. Nothing is deleted.</p>
                <SwitchButton quiet label="Switch parent sign-ins off" pendingLabel="Switching off…" act={setSigninsAction.bind(null, false)} />
              </details>
            </>
          ) : missing.length > 0 ? (
            <><p>Not yet:</p><ul role="status">{missing.map((m) => <li key={m}>{m}</li>)}</ul></>
          ) : (
            <>
              <p>Switching on lets {n(p.people, "person", "people")} sign in, to {n(p.families, "family", "families")}{p.ending.length ? `, and ends ${n(p.ending.length, "sign-in", "sign-ins")} that QuickBooks no longer backs` : ""}. No email is sent: welcome emails are step 3.</p>
              {p.endingUnknown && <p className="hint">Which sign-ins QuickBooks no longer backs would end: {ENDING_BUSY}</p>}
              <SwitchButton label="Switch parent sign-ins on" pendingLabel="Switching on…" act={setSigninsAction.bind(null, true)} />
            </>
          )}
          <p className="box-foot"><a href={`${SETUP}?step=welcome`}>Next: welcome emails</a> · <a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "welcome" && sample && (
        <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Step 3: Welcome emails</h2>
          <p role="status">{p.settings.welcome
            ? "Welcome emails are on. Each new person is emailed once, when they first get access."
            : "Welcome emails are off. Nobody is emailed."}</p>
          {!p.settings.welcome && <p><b>{n(p.welcomeNow, "person", "people")} would be emailed now.</b> After that, each new person is emailed once. They go out a few each minute.</p>}
          <h3>The email</h3>
          <p>Subject: {sample.subject}</p>
          <pre>{sample.text}</pre>
          {p.settings.welcome ? <SwitchButton quiet label="Switch welcome emails off" pendingLabel="Switching off…" act={setWelcomeAction.bind(null, false)} />
            : !p.settings.signin ? <p role="status">Switch parent sign-ins on first (step 2).</p>
            : <SwitchButton label="Switch welcome emails on" pendingLabel="Switching on…" act={setWelcomeAction.bind(null, true)} />}
          <p className="box-foot"><a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}
    </main>
  );
}
