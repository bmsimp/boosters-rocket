import { Notice } from "@/app/components/notice";
import { DataTable, type Column } from "@/app/components/data-table";
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
/** Past this many rows a problem's table is folded, so a real roster's long lists open only when wanted. */
const FOLD_AFTER = 10;
const WHO: Column<{ qboId: string; name: string }>[] = [{ key: "name", header: "Person", rowHeader: true, cell: (r) => r.name }];

/**
 * One problem the clean-up preview found: a heading with its count, then the records as a table (folded behind
 * "Show all" past FOLD_AFTER rows), or a done notice when there are none. Names and addresses are QuickBooks text.
 */
function Problem<R>({ title, noun, rows, rowKey, columns, hint }: {
  title: string; noun: [string, string]; rows: R[]; rowKey: (r: R) => string; columns: Column<R>[]; hint?: string;
}) {
  const table = <DataTable caption={`${title}: ${n(rows.length, ...noun)}`} captionHidden columns={columns} rows={rows} rowKey={rowKey} />;
  return (
    <>
      <h3 className="table-head">{title} ({rows.length})</h3>
      {rows.length === 0 ? <Notice tone="done" live="none">None.</Notice>
        : rows.length > FOLD_AFTER ? <details className="more"><summary>Show all {n(rows.length, ...noun)}</summary>{table}</details> : table}
      {hint && <p className="hint">{hint}</p>}
    </>
  );
}

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
  const sample = step === "welcome" ? await welcomeEmailFor("parent@example.org") : null;
  const switchedOff = p.settings.everEnabled && !p.settings.signin;
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
      <h1 className="page-title">Set up parent sign-ins</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}><a href={`${SETUP}?step=${s.step}`}>{s.label}</a></li>)}</ol>

      {step === "preview" && (
        <section className="box" aria-labelledby="pp-h"><h2 id="pp-h">Step 1: What would happen</h2>
          {missing.length > 0 && <Notice tone="warning"><ul className="notice-list">{missing.map((m) => <li key={m}>{m}</li>)}</ul></Notice>}
          {p.ready.shape && (
            <>
              <Notice tone="info" live="none"><b>{n(p.people, "person", "people")} would be able to sign in, to {n(p.families, "family", "families")}.</b></Notice>
              <p>Nothing below stops you switching on. The people listed just can&apos;t sign in until it is fixed. Fix records in QuickBooks, choose Refresh now on the Roster, and open this page again.</p>
              <Problem title="Addresses under more than one family" noun={["address", "addresses"]} rows={p.held} rowKey={(h) => h.email}
                hint="These are held until someone with access to Parents says whether each is one person." columns={[
                  { key: "email", header: "Address", rowHeader: true, cell: (h) => h.email },
                  { key: "families", header: "Under these families", cell: (h) => h.families.map((f) => f.name).join(", ") },
                ]} />
              <Problem title="No email address" noun={["person", "people"]} rows={p.noEmail} rowKey={(r) => r.qboId} columns={WHO} />
              <Problem title="More than one address on a person's record" noun={["person", "people"]} rows={p.manyAddresses} rowKey={(r) => r.qboId} columns={WHO} />
              <Problem title="Nobody could sign in" noun={["family", "families"]} rows={p.noSignin} rowKey={(r) => r.qboId}
                columns={[{ key: "name", header: "Family", rowHeader: true, cell: (r) => r.name }]} />
              {/* Worked out only while sign-ins are off: once they are on, the reconcile keeps sign-ins in line by itself. */}
              {!on && (p.endingUnknown ? (
                <><h3>Sign-ins that would end</h3><Notice tone="info">{ENDING_BUSY}</Notice></>
              ) : (
                <Problem title="Sign-ins that would end" noun={["sign-in", "sign-ins"]} rows={p.ending} rowKey={(e) => `${e.email}|${e.familyQboId}`}
                  hint="QuickBooks no longer backs these, so they stop working when sign-ins are switched on." columns={[
                    { key: "name", header: "Person", rowHeader: true, cell: (e) => e.name },
                    { key: "email", header: "Address", cell: (e) => e.email },
                  ]} />
              ))}
            </>
          )}
          <p className="box-foot"><a className="btn" href={`${SETUP}?step=signins`}>Next: parent sign-ins</a> <a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "signins" && (
        <section className="box" aria-labelledby="psi-h"><h2 id="psi-h">Step 2: Parent sign-ins</h2>
          {switchedOff && <Notice tone="info">Parent sign-ins are off. Nobody can sign in.</Notice>}
          {p.settings.signin ? (
            <>
              <Notice tone="done" live="none">Parent sign-ins are on. {n(p.people, "person", "people")} can sign in, to {n(p.families, "family", "families")}.</Notice>
              <details><summary>Switch parent sign-ins off</summary>
                <p>Every parent is signed out at once and nobody can sign in until this is switched on again. Welcome emails are switched off too. Nothing is deleted.</p>
                <SwitchButton quiet label="Switch parent sign-ins off" pendingLabel="Switching off…" act={setSigninsAction.bind(null, false)} />
              </details>
            </>
          ) : missing.length > 0 ? (
            <Notice tone="warning">Not yet:<ul className="notice-list">{missing.map((m) => <li key={m}>{m}</li>)}</ul></Notice>
          ) : (
            <>
              <p>Switching on lets {n(p.people, "person", "people")} sign in, to {n(p.families, "family", "families")}{p.ending.length ? `, and ends ${n(p.ending.length, "sign-in", "sign-ins")} that QuickBooks no longer backs` : ""}. No email is sent: welcome emails are step 3.</p>
              {p.endingUnknown && <p className="hint">Which sign-ins QuickBooks no longer backs would end: {ENDING_BUSY}</p>}
              <SwitchButton label="Switch parent sign-ins on" pendingLabel="Switching on…" act={setSigninsAction.bind(null, true)} />
            </>
          )}
          <p className="box-foot"><a className="link-line" href={`${SETUP}?step=welcome`}>Next: welcome emails</a> · <a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "welcome" && sample && (
        <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Step 3: Welcome emails</h2>
          <Notice tone="info">{p.settings.welcome
            ? "Welcome emails are on. Each new person is emailed once, when they first get access."
            : "Welcome emails are off. Nobody is emailed."}</Notice>
          {!p.settings.welcome && <p><b>{n(p.welcomeNow, "person", "people")} would be emailed now.</b> After that, each new person is emailed once. They go out a few each minute.</p>}
          <h3>The email</h3>
          <p>Subject: {sample.subject}</p>
          <pre className="email-sample">{sample.text}</pre>
          {p.settings.welcome ? <SwitchButton quiet label="Switch welcome emails off" pendingLabel="Switching off…" act={setWelcomeAction.bind(null, false)} />
            : !p.settings.signin ? <Notice tone="info">Switch parent sign-ins on first (step 2).</Notice>
            : <SwitchButton label="Switch welcome emails on" pendingLabel="Switching on…" act={setWelcomeAction.bind(null, true)} />}
          <p className="box-foot"><a className="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}
    </main>
  );
}
