import { Card, HowThisWorks, KeyValue, LinkButton, Notice } from "@/app/components/ui";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
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
import { disconnectWarning, SWITCH_PAGE, SWITCH_WORDS } from "./switch-words";
import { getRosterSource } from "@/lib/roster/source";
import { lastCheck, lastCheckWords } from "@/lib/quickbooks/sandbox-check/view";
import { IntegrationHead, IntegrationHealth } from "../integration-head";
import { healthLines, quickbooksRow } from "../statuses";

export const metadata = { title: "QuickBooks settings" };
export const dynamic = "force-dynamic";

/**
 * QuickBooks, an integration's page (the Settings spec, "Integration pages"): its head with the status, what is set,
 * its Health line, its own cards (the membership shape, the roster, the portal's requests), then the change, ending with
 * Disconnect. What is set is shown plainly, with no inputs; changing anything opens the steps.
 */
export default async function QuickBooksSettingsPage() {
  const ctx = await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const [conn, page, wake, problems, settings, people, checked, source, row, lines] = await Promise.all([connectionView(), loadRosterPage(), lastWake(), quickbooksProblems(),
    getParentSettings(), peopleWithAccess(), lastCheck(), getRosterSource(), quickbooksRow(), can(ctx.effective, "Admin.Health.Read") ? healthLines() : []]);
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  const warning = settings.signin && people > 0 ? disconnectWarning(people) : undefined;
  return (
    <main className="wrap single">
      <IntegrationHead of="quickbooks" title="QuickBooks" status={row.status}
        lede={<>{row.does} Only Admins can change these settings, because they reach the club&apos;s books.</>} />
      {problems.length > 0 && <Notice tone="warning" title="Needs attention" titleId="qbo-problems-h"><ul className="notice-list">{problems.map((p) => <li key={p.kind}>{p.text}</li>)}</ul></Notice>}

      <Card title="Connection" titleId="qbo-conn-h">
        <HowThisWorks summary="What the portal does with QuickBooks"><p>{QUICKBOOKS_USE.reads} {QUICKBOOKS_USE.writes} Each change is in the audit log.</p></HowThisWorks>
        {!conn.configured ? <p>QuickBooks isn&apos;t set up yet.</p> : (
          // The company's name is QuickBooks text: a text child, never markup.
          <KeyValue items={[
            { key: "status", label: "Status", value: conn.connected ? <>Connected to <b>{conn.companyName ?? "a QuickBooks company"}</b></> : "Not connected. The Intuit app's keys are saved." },
            { key: "env", label: "Which QuickBooks", value: conn.environment === "production" ? "Production (the club's real books)" : "Sandbox (an Intuit test company)" },
            { key: "client", label: "Client ID", value: <code>{conn.clientId}</code> },
            conn.connected && { key: "at", label: "Connected", value: when(conn.connectedAt) },
            conn.connected && { key: "renewed", label: "Last renewed", value: when(conn.lastTokenRefreshAt) },
            conn.connected && { key: "expires", label: "Expires", value: <>{when(conn.refreshExpiresAt)} unless it is renewed first. The worker renews it every day.</> },
          ]} />
        )}
      </Card>

      <IntegrationHealth id="qbo" here="/staff/settings/quickbooks" line={lines.find((l) => l.key === "quickbooks")} />

      <Card title="Membership shape" titleId="qbo-shape-h">
        <p>{page.shapeWords ?? "Not chosen yet."}</p>
        {page.brokenTypes.length > 0 && <Notice tone="warning">This shape names a customer type QuickBooks no longer has. Choose the shape again.</Notice>}
      </Card>

      <Card title="Roster" titleId="qbo-roster-h">
        <KeyValue items={[
          { key: "read", label: "Last read from QuickBooks", value: <>{page.lastOkAt ? <LocalTime iso={page.lastOkAt} /> : "Not yet"}{page.lastRun && !page.lastRun.ok ? <> (the latest try failed: {page.lastRun.detail})</> : null}{!conn.connected && page.lastOkAt ? ". QuickBooks is disconnected, so the roster is no longer current." : null}</> },
          { key: "found", label: "What it found", value: rosterCounts(page.roster) || "Nothing to show until a shape is chosen." },
          { key: "worker", label: "Worker", value: wake ? <>Last checked in <LocalTime iso={wake} /></> : "Hasn't checked in yet." },
        ]} />
      </Card>

      <Card title={"The portal's requests"} titleId="qbo-check-h">
        <p>{lastCheckWords(checked)}{checked ? <> (<LocalTime iso={checked.at} />)</> : null}</p>
        <p><a className="link-line" href="/staff/settings/quickbooks/check">Check the portal&apos;s requests</a></p>
      </Card>

      <Card title={conn.configured ? "Change" : "Set up"} titleId="qbo-change-h">
        <p>{conn.configured ? "Open the steps to change the Intuit app's keys, renew the connection or choose the shape again." : "Three steps: the Intuit app's keys, signing in to Intuit, and the shape of your membership."}</p>
        <p className="settings-open"><LinkButton href="/staff/settings/quickbooks/setup" variant="primary">{conn.configured ? "Change" : "Set up"}</LinkButton></p>
        {/* A first connect needs no switch: offered only while the roster names a company. */}
        {source !== null && <p>{SWITCH_WORDS.setupHint} <a className="link-line" href={SWITCH_PAGE}>{SWITCH_WORDS.setupLink}</a></p>}
        {/* Disconnect, last, as it is today: it stays in place after it is pressed, to say what it did. */}
        <Disconnect connected={conn.connected} disconnect={disconnectAction} warning={warning} />
      </Card>
    </main>
  );
}
