// Link, not <a>, for /staff/roster below: the no-html-link-for-pages lint rule treats it as the dynamic /staff/roster/[id] route.
import { Notice } from "@/app/components/notice";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { connectionView, qboRedirectUri } from "@/lib/quickbooks/connection";
import { loadRosterPage } from "@/lib/roster/queries";
import { CopyField } from "@/app/components/sign-in-settings/copy-field";
import { AppKeysForm, ConnectForm, ConnectModeForm, RelayRegistration, ShapeForm, type CompanyQuestion } from "../forms";
import { QuickBooksFullLogo } from "../../integration-logo";
import { QuickBooksUse } from "../what-it-does";
import { saveQboAppAction, beginConnectAction, previewShapeAction, saveShapeAction, saveConnectModeAction, makeRelayKeyAction, savePortalIdAction, checkRegistrationAction } from "../actions";
import { addressFitsRelay, portalAddress, registrationMailto, relayRegistrationView } from "@/lib/quickbooks/relay-registration";
import { getClubSettings } from "@/lib/settings/club";
import { getRosterCompany } from "@/lib/roster/source";
import { familiesToLinkAgain, switchPreview } from "@/lib/quickbooks/switch";
import { can } from "@/lib/permissions/effective";
import { CHOOSE_QUICKBOOKS, LINKS_PAGE, relinkLine, ROSTER_COMPANY_REFUSED, STEP2_WORDS, SWITCH_PAGE, SWITCH_WORDS } from "../switch-words";
import { LinkButton } from "@/app/components/ui";

export const metadata = { title: "Set up QuickBooks" };
export const dynamic = "force-dynamic";

type Step = "app" | "connect" | "shape";
const STEPS: { step: Step; label: string }[] = [{ step: "app", label: "1. How to connect" }, { step: "connect", label: "2. Connect to QuickBooks" }, { step: "shape", label: "3. Membership shape" }];
const SETUP = "/staff/settings/quickbooks/setup";
/** Where customer types are made: in QuickBooks itself, never in the portal. */
const MAKE_TYPES = "Customer types are made in QuickBooks, not here: in QuickBooks Online, open the gear menu, then All lists, then Customer types, and make one for each kind of customer the club has (for example Family, Student and Parent). Then give each customer its type on the customer's own page.";
const REFUSED: Record<string, string> = {
  keys: "Save the Intuit app's keys first.",
  not_configured: "Save the Intuit app's keys first.",
  state: "That return from Intuit didn't match a sign-in started here, or it was more than 10 minutes old. Start again.",
  denied: "Intuit didn't give the portal access. Start again and choose Connect when Intuit asks.",
  other_company: "That is a different QuickBooks company from the one already connected. Disconnect first if you mean to switch companies.",
  // A different company with no ask from the switch page (stage 4's slice M8).
  roster_company: ROSTER_COMPANY_REFUSED,
  intuit: "Intuit refused the request. Check the Client ID, the Client secret and the choice of sandbox or production in step 1, and that the redirect address is on the Intuit app.",
  // Through Boosters Rocket (spec §5, Connect).
  environment: CHOOSE_QUICKBOOKS,
  environment_locked: "QuickBooks is connected to the other one. Disconnect first, from QuickBooks settings, to connect this one.",
  relay_refused: "Boosters Rocket didn't accept this portal's request. In step 1, select Check the registration; if the id and key are right, check that the server's clock is right, then email support@boostersrocket.com.",
  relay_busy: "Boosters Rocket is busy just now. Wait a minute, then press Connect to QuickBooks again.",
  relay_unreachable: "Boosters Rocket couldn't be reached, or its answer couldn't be read. Wait a few minutes, then press Connect to QuickBooks again.",
  relay_code: "That connection took too long to finish. Press Connect to QuickBooks again.",
  // Step 2's company question (the owner's finding of 2026-11-25).
  company: STEP2_WORDS.chooseCompany,
  confirm: SWITCH_WORDS.notConfirmed,
  environment_differs: STEP2_WORDS.environmentDiffers,
};
/** The same reasons, worded for a club connecting through Boosters Rocket, where they differ. */
const REFUSED_RELAY: Record<string, string> = {
  keys: "Register the portal with Boosters Rocket in step 1 first.",
  not_configured: "Register the portal with Boosters Rocket in step 1 first.",
  intuit: "Intuit didn't finish the connection with Boosters Rocket. Press Connect to QuickBooks again, and if it happens again, email support@boostersrocket.com.",
};

export default async function QuickBooksSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; };
  const mayLink = can(ctx.effective, "Accounting.Link.ReadWrite");
  const [conn, page, rosterCompany, toLink, registration, club] = await Promise.all([connectionView(), loadRosterPage(), getRosterCompany(), mayLink ? familiesToLinkAgain() : 0,
    relayRegistrationView(), getClubSettings()]);
  const source = rosterCompany;
  const address = portalAddress();
  // A step opens only when the one before it is done (spec §3). With no step asked for: the first one not done yet.
  const reachable: Step = !conn.configured ? "app" : !conn.connected ? "connect" : "shape";
  const order: Step[] = ["app", "connect", "shape"];
  const asked = order.find((s) => s === one("step"));
  if (asked && order.indexOf(asked) > order.indexOf(reachable)) redirect(`${SETUP}?step=${reachable}`);
  const step: Step = asked ?? reachable;
  // Step 2 asks which company while nothing is connected and the roster names one (the owner's finding of 2026-11-25):
  // the same one again, or a different one, with the switch page's lists, counted only when asked.
  let question: CompanyQuestion | null = null;
  if (step === "connect" && !conn.connected && rosterCompany !== null) {
    const p = await switchPreview();
    question = { companyName: rosterCompany.companyName, rosterEnvironment: rosterCompany.environment, ends: SWITCH_WORDS.ends(p), kept: SWITCH_WORDS.kept(p) };
  }
  const key = one("error") ?? "";
  const relay = conn.connectMode === "relay";
  const error = relay && Object.hasOwn(REFUSED_RELAY, key) ? REFUSED_RELAY[key] : Object.hasOwn(REFUSED, key) ? REFUSED[key] : undefined;
  // After a move from the club's own Intuit app, when Intuit didn't confirm it ended that app's access.
  const oldAccessKept = one("moved") === "old_access_kept";
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
      <h1 className="page-title">Set up QuickBooks</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}>{order.indexOf(s.step) <= order.indexOf(reachable) ? <a href={`${SETUP}?step=${s.step}`}>{s.label}</a> : s.label}</li>)}</ol>
      {error && <Notice tone="problem">{error}</Notice>}

      {step === "app" && (
        <section className="box" aria-labelledby="qbo-app-h"><h2 id="qbo-app-h">Step 1: How to connect</h2>
          <p>Choose how the portal reaches the club&apos;s QuickBooks. Nothing is sent to Intuit in this step.</p>
          <ConnectModeForm saved={conn.connectMode} keysSaved={conn.clientId !== null} relayConnected={conn.tokenMode === "relay"} save={saveConnectModeAction}
            relay={<RelayRegistration stage={registration.stage} address={address} addressFits={addressFitsRelay(address)} publicKey={registration.publicKey}
              portalId={registration.portalId} mailto={registration.publicKey ? registrationMailto({ clubName: club.name, address, publicKey: registration.publicKey }) : null}
              mayChange={conn.tokenMode !== "relay" && !conn.relayConnectPending} makeKey={makeRelayKeyAction} saveId={savePortalIdAction} check={checkRegistrationAction} />}
            ownApp={
              <section className="box-section stack" aria-labelledby="qbo-own-app-h"><h3 id="qbo-own-app-h">Your Intuit app</h3>
                <p>The portal reaches QuickBooks through an app the club registers with Intuit. This tells the portal which app that is.</p>
                <ol className="steps-list">
                  <li>Sign in at <a href="https://developer.intuit.com" target="_blank" rel="noreferrer">developer.intuit.com</a> and open the club&apos;s app (or create one for QuickBooks Online, with the Accounting scope).</li>
                  <li>In the app&apos;s <b>Settings</b>, open <b>Redirect URIs</b> and add this address exactly, on the tab for the keys you are going to use (Development for sandbox, Production for the real books):
                    <CopyField label="Redirect address" value={qboRedirectUri()} /></li>
                  <li>Copy the <b>Client ID</b> and <b>Client secret</b> from the app&apos;s <b>Keys and credentials</b> page into the form below, and choose sandbox or production to match.</li>
                </ol>
                <AppKeysForm configured={conn.clientId !== null} clientId={conn.clientId} environment={conn.ownAppEnvironment} save={saveQboAppAction} />
              </section>} />
          <p className="box-foot"><a className="link-line" href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
        </section>
      )}

      {step === "connect" && (
        <section className="box" aria-labelledby="qbo-connect-h"><h2 id="qbo-connect-h">Step 2: Connect to QuickBooks</h2>
          <p>This sends you to Intuit to choose the club&apos;s QuickBooks company and approve access, then brings you back here. Sign in as someone who is an admin of that company.</p>
          <QuickBooksUse />
          {relay && <p>The portal connects through Boosters Rocket: Intuit asks you to approve Boosters Rocket Connect, then sends you back here.</p>}
          {conn.connected && <p className="hint">QuickBooks is connected to <b>{conn.companyName ?? "a company"}</b>. Connecting again renews the connection to the same company.</p>}
          {relay && conn.connected && conn.tokenMode === "own_app" && <Notice tone="info">The portal is connected with the club&apos;s own Intuit app now. Connecting through Boosters Rocket to the same company moves it over, then asks Intuit to end the old app&apos;s access.</Notice>}
          <QuickBooksFullLogo />
          <ConnectForm relay={relay} environment={conn.environment} locked={conn.connected} ownAppEnvironment={conn.ownAppEnvironment} question={question} begin={beginConnectAction} />
          {/* A first connect needs no switch: offered only while the roster names a company. Step 2 asks the same
              while nothing is connected; the switch page stays a way in, and says to disconnect first while connected. */}
          {source !== null && <p>{SWITCH_WORDS.setupHint}</p>}
          {source !== null && <p><LinkButton variant="secondary" href={SWITCH_PAGE}>{SWITCH_WORDS.setupLink}</LinkButton></p>}
          <p className="box-foot"><a href={`${SETUP}?step=app`}>Back to step 1</a>{conn.connected && <> · <a href={`${SETUP}?step=shape`}>Skip to step 3</a></>}</p>
        </section>
      )}

      {step === "shape" && (
        <section className="box" aria-labelledby="qbo-shape-h"><h2 id="qbo-shape-h">Step 3: The shape of your membership</h2>
          {/* The company's name is free text from QuickBooks: a text child, never markup. */}
          <p>{`Connected to ${conn.companyName ?? "a QuickBooks company"}.`} If that isn&apos;t the club&apos;s company, go back to QuickBooks settings and disconnect.</p>
          {oldAccessKept && <Notice tone="warning">The portal now connects through Boosters Rocket, but Intuit didn&apos;t confirm that it ended the club&apos;s own Intuit app&apos;s access. That app may still be listed in QuickBooks&apos; Apps list, where an admin of the company can disconnect it.</Notice>}
          {toLink > 0 && conn.connected && <Notice tone="info">{relinkLine(toLink)} <a href={LINKS_PAGE}>Accounting links</a></Notice>}
          <p>Tell the portal which QuickBooks customer types are the club&apos;s members. Customers of any other type, such as schools or vendors, stay out of the portal. When you save, the portal reads the roster again with the new shape. You can change this later.</p>
          {page.types.length === 0
            ? <Notice tone="info">{page.lastRun && !page.lastRun.ok
              ? <>The portal couldn&apos;t read QuickBooks just now{page.lastRun.detail ? `: ${page.lastRun.detail}` : "."} Open <Link href="/staff/roster">Roster</Link> and select <b>Refresh now</b> to try again, then come back.</>
              : page.lastRun
                ? <>QuickBooks has no customer types yet, so there is nothing to choose from. {MAKE_TYPES} Then open <Link href="/staff/roster">Roster</Link>, select <b>Refresh now</b>, and come back.</>
                : <>The portal hasn&apos;t read any customer types from QuickBooks yet. Open <Link href="/staff/roster">Roster</Link> and select <b>Refresh now</b>, then come back. If QuickBooks has no customer types: {MAKE_TYPES}</>}</Notice>
            : <ShapeForm types={page.types} shape={page.shape} preview={previewShapeAction} save={saveShapeAction} />}
          <p className="box-foot"><a className="link-line" href={`${SETUP}?step=connect`}>Back to step 2</a> · <a className="link-line" href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
        </section>
      )}
    </main>
  );
}
