import { Notice } from "@/app/components/notice";
import { requireStaffPage } from "@/lib/guards";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { QUICKBOOKS_USE } from "@/lib/quickbooks/what-it-does";
import { loadRosterPage } from "@/lib/roster/queries";
import { lastWake } from "@/lib/jobs/runner";
import { LocalTime } from "@/app/components/local-time";
import { Disconnect } from "./forms";
import { disconnectAction } from "./actions";
import { rosterCounts } from "./roster-counts";
import { getParentSettings } from "@/lib/parents/settings";
import { peopleWithAccess } from "@/lib/parents/switches";
import { BackToSettings } from "../back-to-settings";
import { StateWords } from "@/app/components/state-words";
import { lastCheck, lastCheckWords } from "@/lib/quickbooks/sandbox-check/view";

export const metadata = { title: "QuickBooks settings" };
export const dynamic = "force-dynamic";

/** What is set, shown plainly, with no inputs (spec §3 The settings view). Changing anything opens the steps. */
export default async function QuickBooksSettingsPage() {
  await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const [conn, page, wake, problems, settings, people, checked] = await Promise.all([connectionView(), loadRosterPage(), lastWake(), quickbooksProblems(), getParentSettings(), peopleWithAccess(), lastCheck()]);
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  const warning = settings.signin && people > 0 ? `${people} ${people === 1 ? "person" : "people"} can sign in to the portal now. Connecting a different QuickBooks company afterwards ends all of that access, switches parent sign-ins and welcome emails off, and needs them set up again. Reconnecting this same company changes nothing.` : undefined;
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">QuickBooks</h1>
      <p className="lede">{QUICKBOOKS_USE.reads} {QUICKBOOKS_USE.writes} Each change is in the audit log. Only Admins can change these settings, because they reach the club&apos;s books.</p>
      {problems.length > 0 && <Notice tone="warning" title="Needs attention" titleId="qbo-problems-h"><ul className="notice-list">{problems.map((p) => <li key={p.kind}>{p.text}</li>)}</ul></Notice>}

      <section className="box" aria-labelledby="qbo-conn-h"><h2 id="qbo-conn-h">Connection</h2>
        <StateWords state={conn.connected && problems.length === 0 ? "done" : "todo"} words={!conn.configured ? "Not set up yet" : !conn.connected ? "Not connected" : problems.length ? "Connected, and something needs attention" : "Connected"} />
        {!conn.configured ? <p>QuickBooks isn&apos;t set up yet.</p> : (
          <dl className="details">
            <dt>Status</dt><dd>{conn.connected ? <>Connected to <b>{conn.companyName ?? "a QuickBooks company"}</b></> : "Not connected. The Intuit app's keys are saved."}</dd>
            <dt>Which QuickBooks</dt><dd>{conn.environment === "production" ? "Production (the club's real books)" : "Sandbox (an Intuit test company)"}</dd>
            <dt>Client ID</dt><dd><code>{conn.clientId}</code></dd>
            {conn.connected && <><dt>Connected</dt><dd>{when(conn.connectedAt)}</dd>
              <dt>Last renewed</dt><dd>{when(conn.lastTokenRefreshAt)}</dd>
              <dt>Expires</dt><dd>{when(conn.refreshExpiresAt)} unless it is renewed first. The worker renews it every day.</dd></>}
          </dl>
        )}
      </section>

      <section className="box" aria-labelledby="qbo-shape-h"><h2 id="qbo-shape-h">Membership shape</h2>
        <p>{page.shapeWords ?? "Not chosen yet."}</p>
        {page.brokenTypes.length > 0 && <Notice tone="warning">This shape names a customer type QuickBooks no longer has. Choose the shape again.</Notice>}
      </section>

      <section className="box" aria-labelledby="qbo-roster-h"><h2 id="qbo-roster-h">Roster</h2>
        <dl className="details">
          <dt>Last read from QuickBooks</dt><dd>{page.lastOkAt ? <LocalTime iso={page.lastOkAt} /> : "Not yet"}{page.lastRun && !page.lastRun.ok ? <> (the latest try failed: {page.lastRun.detail})</> : null}{!conn.connected && page.lastOkAt ? ". QuickBooks is disconnected, so the roster is no longer current." : null}</dd>
          <dt>What it found</dt><dd>{rosterCounts(page.roster) || "Nothing to show until a shape is chosen."}</dd>
          <dt>Worker</dt><dd>{wake ? <>Last checked in <LocalTime iso={wake} /></> : "Hasn't checked in yet."}</dd>
        </dl>
      </section>

      <section className="box" aria-labelledby="qbo-check-h"><h2 id="qbo-check-h">The portal&apos;s requests</h2>
        <p>{lastCheckWords(checked)}{checked ? <> (<LocalTime iso={checked.at} />)</> : null}</p>
        <p><a className="link-line" href="/staff/settings/quickbooks/check">Check the portal&apos;s requests</a></p>
      </section>

      <section className="box" aria-labelledby="qbo-change-h"><h2 id="qbo-change-h">{conn.configured ? "Change" : "Set up"}</h2>
        <p>{conn.configured ? "Open the steps to change the Intuit app's keys, renew the connection or choose the shape again." : "Three steps: the Intuit app's keys, signing in to Intuit, and the shape of your membership."}</p>
        <p><a className="btn" href="/staff/settings/quickbooks/setup">{conn.configured ? "Change" : "Set up"}</a></p>
        <Disconnect connected={conn.connected} disconnect={disconnectAction} warning={warning} />
      </section>
    </main>
  );
}
