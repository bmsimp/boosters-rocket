import { requireStaffPage } from "@/lib/guards";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { loadRosterPage } from "@/lib/roster/queries";
import { lastWake } from "@/lib/jobs/runner";
import { LocalTime } from "@/app/components/local-time";
import { DisconnectButton } from "./forms";
import { disconnectAction } from "./actions";
import { rosterCounts } from "./roster-counts";

export const metadata = { title: "QuickBooks settings" };
export const dynamic = "force-dynamic";

/** What is set, shown plainly, with no inputs (spec §3 The settings view). Changing anything opens the steps. */
export default async function QuickBooksSettingsPage() {
  await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const [conn, page, wake, problems] = await Promise.all([connectionView(), loadRosterPage(), lastWake(), quickbooksProblems()]);
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  return (
    <main className="wrap single">
      <h1 className="page-title">QuickBooks</h1>
      <p className="lede">The club&apos;s families and members come from QuickBooks. The portal reads them; it changes nothing in QuickBooks. Only Admins can change this, because it reaches the club&apos;s books.</p>
      {problems.length > 0 && <section className="box" role="status" aria-labelledby="qbo-problems-h"><h2 id="qbo-problems-h">Needs attention</h2><ul>{problems.map((p) => <li key={p.kind}>{p.text}</li>)}</ul></section>}

      <section className="box" aria-labelledby="qbo-conn-h"><h2 id="qbo-conn-h">Connection</h2>
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
        {page.brokenTypes.length > 0 && <p role="status">This shape names a customer type QuickBooks no longer has. Choose the shape again.</p>}
      </section>

      <section className="box" aria-labelledby="qbo-roster-h"><h2 id="qbo-roster-h">Roster</h2>
        <dl className="details">
          <dt>Last read from QuickBooks</dt><dd>{page.lastOkAt ? <LocalTime iso={page.lastOkAt} /> : "Not yet"}{page.lastRun && !page.lastRun.ok ? <> (the latest try failed: {page.lastRun.detail})</> : null}</dd>
          <dt>What it found</dt><dd>{rosterCounts(page.roster) || "Nothing to show until a shape is chosen."}</dd>
          <dt>Worker</dt><dd>{wake ? <>Last checked in <LocalTime iso={wake} /></> : "Hasn't checked in yet."}</dd>
        </dl>
      </section>

      <section className="box" aria-labelledby="qbo-change-h"><h2 id="qbo-change-h">{conn.configured ? "Change" : "Set up"}</h2>
        <p>{conn.configured ? "Open the steps to change the Intuit app's keys, renew the connection or choose the shape again." : "Three steps: the Intuit app's keys, signing in to Intuit, and the shape of your membership."}</p>
        <p><a className="btn" href="/staff/settings/quickbooks/setup">{conn.configured ? "Change" : "Set up"}</a></p>
        {conn.connected && <details><summary>Disconnect</summary>
          <p>This asks Intuit to cancel the portal&apos;s access and deletes its copy of the connection. The Intuit app&apos;s keys and the last roster stay, and the roster is marked as no longer current.</p>
          <DisconnectButton disconnect={disconnectAction} /></details>}
      </section>
    </main>
  );
}
