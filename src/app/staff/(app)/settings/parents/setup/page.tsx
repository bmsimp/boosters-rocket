import { LinkButton } from "@/app/components/ui";
import { Notice } from "@/app/components/notice";
import { requireStaffPage } from "@/lib/guards";
import { factorCounts, LEVEL_UNREADABLE, missingForSignins, signinCounts, type FactorCounts } from "@/lib/parents/switches";
import { readStoredSettings } from "@/lib/parents/settings";
import { sampleWelcome } from "@/lib/parents/welcome";
import { lifeWords } from "@/lib/parents/link-delivery";
import { LINK_LIFE_MS } from "@/lib/parents/signin-links";
import { SwitchButton } from "../forms";
import { setLevelAction, setSigninsAction, setWelcomeAction } from "../actions";

export const metadata = { title: "Set up parent sign-ins" };
export const dynamic = "force-dynamic";

type Step = "signins" | "welcome" | "level";
const STEPS: { step: Step; label: string }[] = [{ step: "signins", label: "1. Parent sign-ins" }, { step: "welcome", label: "2. Welcome emails" },
  { step: "level", label: "3. Sign-in level" }];
const SETUP = "/staff/settings/parents/setup";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What switching to Strict does, for the count of guardians with neither a passkey nor an authenticator app (slice SI-10b).
 * With parent sign-ins off nobody can be signed in (the gate ends any session while the door is closed), so the switch
 * signs out nobody who could reach anything, and the count is of who could sign in once they are on.
 */
function strictConfirm(neither: number, signinOn: boolean): string {
  if (!signinOn) {
    if (neither === 0) return "Parent sign-ins are off, so switching to Strict signs nobody out. Every guardian who could sign in once they are on has a passkey or an authenticator app.";
    return "Parent sign-ins are off, so switching to Strict signs nobody out. Once they are on, a guardian with neither a passkey nor an authenticator app adds one after their password, before they see their family's page.";
  }
  if (neither === 0) return "Switching to Strict signs nobody out: every guardian who can sign in has a passkey or an authenticator app.";
  if (neither === 1) return "Switching to Strict signs out the 1 guardian who has neither a passkey nor an authenticator app. The next time they sign in, their password takes them to add one before they see their family's page. If they've forgotten their password, they'll need you to reset their sign-in from their page on Parents.";
  return `Switching to Strict signs out the ${neither} guardians who have neither a passkey nor an authenticator app. The next time they sign in, their password takes them to add one before they see their family's page. Anyone who has forgotten their password will need you to reset their sign-in from their page on Parents.`;
}

/** The counts step 3 shows: who can sign in (with sign-ins off, who could once they are on), and with what second step of their own. */
function FactorDetails({ c, signinOn }: { c: FactorCounts; signinOn: boolean }) {
  return (
    <dl className="details">
      <dt>{signinOn ? "Can sign in" : "Could sign in once sign-ins are on"}</dt><dd>{n(c.people, "person", "people")}</dd>
      <dt>Have a passkey</dt><dd>{c.passkey}</dd>
      <dt>Have an authenticator app</dt><dd>{c.app}</dd>
      <dt>Have neither</dt><dd>{c.neither}</dd>
    </dl>
  );
}

/**
 * The three steps (spec §3; the third, the sign-in level, since the sign-in release's slice SI-10b). A pressed switch re-renders the page without its button, and so without that button's
 * message: each step therefore says the state it is in, in words, whatever was pressed. Who can sign in is the portal's
 * own guardian rows, counted as the gate counts them (src/lib/parents/sessions.ts): switching on opens and closes none.
 */
export default async function ParentSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const sp = await searchParams;
  const asked = STEPS.find((s) => s.step === (typeof sp.step === "string" ? sp.step : ""))?.step;
  const [{ settings, level }, counts, missing] = await Promise.all([readStoredSettings(), signinCounts(), missingForSignins()]);
  const step: Step = asked ?? (settings.signin ? "welcome" : "signins");
  const sample = step === "welcome" ? await sampleWelcome("parent@example.org") : null;
  const factors = step === "level" ? await factorCounts() : null;
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
          <p className="box-foot"><LinkButton href={`${SETUP}?step=welcome`}>Next: welcome emails</LinkButton> <a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "welcome" && sample && (
        <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Step 2: Welcome emails</h2>
          <Notice tone="info">{settings.welcome
            ? "Welcome emails are on. Everyone who could sign in when they were switched on is emailed once, and so is a guardian staff add or reinstate later, once they can sign in. Nobody else is emailed later by themselves: a family that gets its first active student, or becomes active again, sends no welcome to the guardians it had."
            : "Welcome emails are off. Nobody is emailed."}</Notice>
          {!settings.welcome && <p><b>{n(counts.welcomeNow, "person", "people")} would be emailed now.</b> Someone who can only sign in later isn&apos;t emailed by themselves, but a guardian staff add or reinstate while welcome emails are on is emailed once they can sign in. They go out a few each minute.</p>}
          <h3>The email</h3>
          <p>{`The welcome carries a link the person uses to choose their password, made for them when it is sent. It works once, for ${lifeWords(LINK_LIFE_MS.setup)}; after that, ${settings.level === "strict" ? "staff send the welcome again from the person's page on Parents" : "they can ask for a new one from “Set up or reset my password” on the sign-in page, or staff can send the welcome again from the person's page on Parents"}. Someone who has a password already is sent it with no link, saying to sign in with their password.`}</p>
          <p>Subject: {sample.subject}</p>
          <pre className="email-sample">{sample.text}</pre>
          {settings.welcome ? <SwitchButton quiet label="Switch welcome emails off" pendingLabel="Switching off…" act={setWelcomeAction.bind(null, false)} />
            : !settings.signin ? <Notice tone="info">Switch parent sign-ins on first (step 1).</Notice>
            : <SwitchButton label="Switch welcome emails on" pendingLabel="Switching on…" act={setWelcomeAction.bind(null, true)} />}
          <p className="box-foot"><LinkButton href={`${SETUP}?step=level`}>Next: sign-in level</LinkButton> <a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "level" && factors && (
        <section className="box" aria-labelledby="pl-h"><h2 id="pl-h">Step 3: Sign-in level</h2>
          {level === "standard" && <Notice tone="info">The club is at Standard: a password, and on a phone or computer the portal doesn&apos;t know yet, a code we email, or the guardian&apos;s own passkey or authenticator app.</Notice>}
          {level === "strict" && <Notice tone="info">The club is at Strict: a password and a passkey or an authenticator app, every time. An emailed code never signs anyone in.</Notice>}
          {level === null && <Notice tone="warning">{LEVEL_UNREADABLE}</Notice>}
          <FactorDetails c={factors} signinOn={settings.signin} />
          {level === "standard" && <p>Strict asks every guardian for a passkey or an authenticator app each time they sign in, and an emailed code never signs anyone in. Switch once most guardians have one.</p>}
          {level !== "strict" && (
            <details><summary>Switch to Strict</summary>
              <Notice tone="warning" live="none">{strictConfirm(factors.neither, settings.signin)}</Notice>
              <SwitchButton label="Switch to Strict" pendingLabel="Switching…" act={setLevelAction.bind(null, "strict", factors.neither)} />
            </details>
          )}
          {level !== "standard" && (
            <details><summary>Switch back to Standard</summary>
              <p>Switching back to Standard lets guardians with no passkey or app sign in with their password and a code we email again. Nobody is signed out, and every passkey and app stays.</p>
              <SwitchButton quiet label="Switch back to Standard" pendingLabel="Switching…" act={setLevelAction.bind(null, "standard", null)} />
            </details>
          )}
          <p className="box-foot"><a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}
    </main>
  );
}
