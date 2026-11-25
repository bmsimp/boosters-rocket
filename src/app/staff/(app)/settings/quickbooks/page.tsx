import { Card, KeyValue, LinkButton, Notice } from "@/app/components/ui";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { loadRosterPage } from "@/lib/roster/queries";
import { lastWake } from "@/lib/jobs/runner";
import { LocalTime } from "@/app/components/local-time";
import { Disconnect } from "./forms";
import { QuickBooksUse } from "./what-it-does";
import { disconnectAction } from "./actions";
import { rosterCounts } from "./roster-counts";
import { getParentSettings } from "@/lib/parents/settings";
import { peopleWithAccess } from "@/lib/parents/switches";
import { disconnectWarning, SWITCH_PAGE, SWITCH_WORDS } from "./switch-words";
import { getRosterSource } from "@/lib/roster/source";
import { lastCheck, lastCheckWords } from "@/lib/quickbooks/sandbox-check/view";
import { IntegrationHead, IntegrationHealth } from "../integration-head";
import { healthLines, quickbooksRow } from "../statuses";
import { SupportLine } from "../../support-line";
import { qboRelayUrl } from "@/lib/quickbooks/relay-address";

export const metadata = { title: "QuickBooks settings" };

/**
 * How the portal connects: the choice for the next Connect, and, when the tokens held were issued the other way (a club
 * that chose the relay and hasn't connected through it yet), what is in use until then.
 */
function howItConnects(conn: { connectMode: "relay" | "own_app"; tokenMode: "relay" | "own_app" | null }): string {
  const words = { relay: "Through Boosters Rocket", own_app: "With the club's own Intuit app" } as const;
  if (conn.tokenMode && conn.tokenMode !== conn.connectMode) return `${words[conn.connectMode]} from the next Connect. ${words[conn.tokenMode]} until then.`;
  return words[conn.connectMode];
}
export const dynamic = "force-dynamic";

/**
 * QuickBooks, an integration's page (the Settings spec, "Integration pages"): its head with the status, its Health
 * line only when it needs attention, then two surfaces: Connection (what is set, and the roster's section: the
 * membership shape, the last read, the worker and the portal's requests) and the change, ending with Disconnect. What is set is shown plainly, with no inputs; changing anything opens the steps.
 */
/**
 * Boosters Rocket Connect sends a person here from QuickBooks' own Apps list (the relay's SPEC.md section 2, "Launch,
 * Disconnect and Connect/Reconnect from QuickBooks"), with one of these. A fixed Notice for each; anything else is
 * ignored, and nothing in the address is ever shown.
 */
/**
 * The way in to Boosters Rocket's shared connection for a club connected with its own Intuit app: step 1 is where the
 * choice is made, and a connected club's Change opens on step 3, so this links straight to it.
 */
const MOVE_TO_RELAY = {
  title: "You can move to Boosters Rocket's connection",
  body: "QuickBooks is connected with the club's own Intuit app. Boosters Rocket can hold the connection instead, so the club needs no Intuit app of its own. Everything keeps working as it is until the move is done.",
  link: "Move to Boosters Rocket",
  href: "/staff/settings/quickbooks/setup?step=app",
} as const;

const FROM_QUICKBOOKS: Record<string, string> = {
  disconnected: "QuickBooks says the portal was disconnected there. Connect again to carry on.",
  connect: "Connect QuickBooks from the steps below.",
};

export default async function QuickBooksSettingsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const ctx = await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const intuit = (await searchParams)?.intuit;
  const fromQuickBooks = typeof intuit === "string" && Object.hasOwn(FROM_QUICKBOOKS, intuit) ? FROM_QUICKBOOKS[intuit] : undefined;
  const [conn, page, wake, problems, settings, people, checked, source, row, lines] = await Promise.all([connectionView(), loadRosterPage(), lastWake(), quickbooksProblems(),
    getParentSettings(), peopleWithAccess(), lastCheck(), getRosterSource(), quickbooksRow(), can(ctx.effective, "Admin.Health.Read") ? healthLines() : []]);
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  const warning = settings.signin && people > 0 ? disconnectWarning(people) : undefined;
  return (
    <main className="wrap single">
      <IntegrationHead of="quickbooks" title="QuickBooks" status={row.status}
        lede={<>{row.does} Only Admins can change these settings, because they reach the club&apos;s books.</>} />
      {fromQuickBooks && <Notice tone="info">{fromQuickBooks}</Notice>}
      {/* Only for someone who may change these settings: the page's own guard says so today, and this keeps it so if that guard ever widens. */}
      {conn.tokenMode === "own_app" && can(ctx.effective, "Settings.QuickBooks.ReadWrite") && (
        <Notice tone="info" live="none" title={MOVE_TO_RELAY.title} titleId="qbo-move-h">
          <p>{MOVE_TO_RELAY.body}</p>
          <p className="box-foot"><LinkButton variant="secondary" href={MOVE_TO_RELAY.href}>{MOVE_TO_RELAY.link}</LinkButton></p>
        </Notice>
      )}
      {problems.length > 0 && <Notice tone="warning" title="Needs attention" titleId="qbo-problems-h"><ul className="notice-list">{problems.map((p) => <li key={p.kind}>{p.text}{p.fix && <> <LinkButton plain variant="secondary" size="sm" href={p.fix.href}>{p.fix.label}</LinkButton></>}</li>)}</ul></Notice>}
      <IntegrationHealth here="/staff/settings/quickbooks" line={lines.find((l) => l.key === "quickbooks")} />

      {conn.configured && (
        <Card title="Connection" titleId="qbo-conn-h">
          <QuickBooksUse />
          {/* The company's name is QuickBooks text: a text child, never markup. */}
          <KeyValue items={[
            { key: "company", label: "Company", value: conn.connected ? <b>{conn.companyName ?? "A QuickBooks company"}</b> : conn.connectMode === "relay" ? "None. The portal is registered with Boosters Rocket." : "None. The Intuit app's keys are saved." },
            { key: "how", label: "How it connects", value: howItConnects(conn) },
            conn.connectMode === "relay" && { key: "relay", label: "Boosters Rocket's address", value: <code>{qboRelayUrl()}</code> },
            { key: "env", label: "Which QuickBooks", value: conn.environment === "production" ? "Production (the club's real books)" : conn.environment === "sandbox" ? "Sandbox (an Intuit test company)" : "Chosen when you connect" },
            conn.connectMode === "own_app" && { key: "client", label: "Client ID", value: <code>{conn.clientId}</code> },
            conn.connected && { key: "at", label: "Connected", value: when(conn.connectedAt) },
            conn.connected && { key: "renewed", label: "Last renewed", value: when(conn.lastTokenRefreshAt) },
            conn.connected && { key: "expires", label: "Expires", value: <>{when(conn.refreshExpiresAt)} unless it is renewed first. The worker renews it every day.</> },
          ]} />
          <section className="box-section" aria-labelledby="qbo-roster-h">
            <h3 id="qbo-roster-h">Roster</h3>
            <KeyValue items={[
              { key: "shape", label: "Membership shape", value: page.shapeWords ?? "Not chosen yet." },
              { key: "read", label: "Last read from QuickBooks", value: <>{page.lastOkAt ? <LocalTime iso={page.lastOkAt} /> : "Not yet"}{page.lastRun && !page.lastRun.ok ? <> (the latest try failed: {page.lastRun.detail})</> : null}{!conn.connected && page.lastOkAt ? ". QuickBooks is disconnected, so the roster is no longer current." : null}</> },
              { key: "found", label: "What it found", value: rosterCounts(page.roster) || "Nothing to show until a shape is chosen." },
              { key: "worker", label: "Worker", value: wake ? <>Last checked in <LocalTime iso={wake} /></> : "Hasn't checked in yet." },
              { key: "requests", label: "The portal's requests", value: <>{lastCheckWords(checked)}{checked ? <> (<LocalTime iso={checked.at} />)</> : null} <LinkButton plain variant="secondary" size="sm" href="/staff/settings/quickbooks/check">Check the portal&apos;s requests</LinkButton></> },
            ]} />
            {page.brokenTypes.length > 0 && <Notice tone="warning">This shape names a customer type QuickBooks no longer has. Choose the shape again.</Notice>}
          </section>
        </Card>
      )}

      <Card title={conn.configured ? "Change" : "Set up"} titleId="qbo-change-h">
        <p>{conn.configured ? "Open the steps to change how the portal connects, renew the connection or choose the shape again." : "Three steps: how the portal connects, signing in to Intuit, and the shape of your membership."}</p>
        <p className="settings-open"><LinkButton href="/staff/settings/quickbooks/setup" variant="primary">{conn.configured ? "Change" : "Set up"}</LinkButton></p>
        {/* A first connect needs no switch: offered only while the roster names a company. */}
        {source !== null && <p>{SWITCH_WORDS.setupHint}</p>}
        {source !== null && <p><LinkButton variant="secondary" href={SWITCH_PAGE}>{SWITCH_WORDS.setupLink}</LinkButton></p>}
        {/* Disconnect, last, as it is today: it stays in place after it is pressed, to say what it did. */}
        <Disconnect connected={conn.connected} disconnect={disconnectAction} warning={warning} through={conn.tokenMode} />
      </Card>
      <SupportLine />
    </main>
  );
}
