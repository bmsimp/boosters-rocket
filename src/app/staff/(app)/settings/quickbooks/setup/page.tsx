// Link, not <a>, for /staff/roster below: the no-html-link-for-pages lint rule treats it as the dynamic /staff/roster/[id] route.
import { Notice } from "@/app/components/notice";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { connectionView, qboRedirectUri } from "@/lib/quickbooks/connection";
import { QUICKBOOKS_USE } from "@/lib/quickbooks/what-it-does";
import { loadRosterPage } from "@/lib/roster/queries";
import { CopyField } from "@/app/components/sign-in-settings/copy-field";
import { AppKeysForm, ShapeForm } from "../forms";
import { saveQboAppAction, beginConnectAction, previewShapeAction, saveShapeAction } from "../actions";

export const metadata = { title: "Set up QuickBooks" };
export const dynamic = "force-dynamic";

type Step = "app" | "connect" | "shape";
const STEPS: { step: Step; label: string }[] = [{ step: "app", label: "1. Intuit app" }, { step: "connect", label: "2. Sign in to Intuit" }, { step: "shape", label: "3. Membership shape" }];
const SETUP = "/staff/settings/quickbooks/setup";
/** Where customer types are made: in QuickBooks itself, never in the portal. */
const MAKE_TYPES = "Customer types are made in QuickBooks, not here: in QuickBooks Online, open the gear menu, then All lists, then Customer types, and make one for each kind of customer the club has (for example Family, Student and Parent). Then give each customer its type on the customer's own page.";
const REFUSED: Record<string, string> = {
  keys: "Save the Intuit app's keys first.",
  not_configured: "Save the Intuit app's keys first.",
  state: "That return from Intuit didn't match a sign-in started here, or it was more than 10 minutes old. Start again.",
  denied: "Intuit didn't give the portal access. Start again and choose Connect when Intuit asks.",
  other_company: "That is a different QuickBooks company from the one already connected. Disconnect first if you mean to switch companies.",
  intuit: "Intuit refused the request. Check the Client ID, the Client secret and the choice of sandbox or production in step 1, and that the redirect address is on the Intuit app.",
};

export default async function QuickBooksSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; };
  const [conn, page] = await Promise.all([connectionView(), loadRosterPage()]);
  // A step opens only when the one before it is done (spec §3). With no step asked for: the first one not done yet.
  const reachable: Step = !conn.configured ? "app" : !conn.connected ? "connect" : "shape";
  const order: Step[] = ["app", "connect", "shape"];
  const asked = order.find((s) => s === one("step"));
  if (asked && order.indexOf(asked) > order.indexOf(reachable)) redirect(`${SETUP}?step=${reachable}`);
  const step: Step = asked ?? reachable;
  const key = one("error") ?? "";
  const error = Object.hasOwn(REFUSED, key) ? REFUSED[key] : undefined;
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
      <h1 className="page-title">Set up QuickBooks</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}>{order.indexOf(s.step) <= order.indexOf(reachable) ? <a href={`${SETUP}?step=${s.step}`}>{s.label}</a> : s.label}</li>)}</ol>
      {error && <Notice tone="problem">{error}</Notice>}

      {step === "app" && (
        <section className="box" aria-labelledby="qbo-app-h"><h2 id="qbo-app-h">Step 1: Your Intuit app</h2>
          <p>The portal reaches QuickBooks through an app the club registers with Intuit. This step tells the portal which app that is. Nothing is sent to Intuit yet.</p>
          <ol className="steps-list">
            <li>Sign in at <a href="https://developer.intuit.com" target="_blank" rel="noreferrer">developer.intuit.com</a> and open the club&apos;s app (or create one for QuickBooks Online, with the Accounting scope).</li>
            <li>In the app&apos;s <b>Settings</b>, open <b>Redirect URIs</b> and add this address exactly, on the tab for the keys you are going to use (Development for sandbox, Production for the real books):
              <CopyField label="Redirect address" value={qboRedirectUri()} /></li>
            <li>Copy the <b>Client ID</b> and <b>Client secret</b> from the app&apos;s <b>Keys and credentials</b> page into the form below, and choose sandbox or production to match.</li>
          </ol>
          <AppKeysForm configured={conn.configured} clientId={conn.clientId} environment={conn.environment} save={saveQboAppAction} />
          <p className="box-foot"><a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
        </section>
      )}

      {step === "connect" && (
        <section className="box" aria-labelledby="qbo-connect-h"><h2 id="qbo-connect-h">Step 2: Sign in to Intuit</h2>
          <p>This sends you to Intuit to choose the club&apos;s QuickBooks company and approve access, then brings you back here. Sign in as someone who is an admin of that company. {QUICKBOOKS_USE.reads} {QUICKBOOKS_USE.writes}</p>
          {conn.connected && <p className="hint">QuickBooks is connected to <b>{conn.companyName ?? "a company"}</b>. Signing in again renews the connection to the same company.</p>}
          <form action={beginConnectAction}><button className="btn">Sign in to Intuit</button></form>
          <p className="box-foot"><a href={`${SETUP}?step=app`}>Back to step 1</a>{conn.connected && <> · <a href={`${SETUP}?step=shape`}>Skip to step 3</a></>}</p>
        </section>
      )}

      {step === "shape" && (
        <section className="box" aria-labelledby="qbo-shape-h"><h2 id="qbo-shape-h">Step 3: The shape of your membership</h2>
          {/* The company's name is free text from QuickBooks: a text child, never markup. */}
          <p>{`Connected to ${conn.companyName ?? "a QuickBooks company"}.`} If that isn&apos;t the club&apos;s company, go back to QuickBooks settings and disconnect.</p>
          <p>Tell the portal which QuickBooks customer types are the club&apos;s members. Customers of any other type, such as schools or vendors, stay out of the portal. When you save, the portal reads the roster again with the new shape. You can change this later.</p>
          {page.types.length === 0
            ? <Notice tone="info">{page.lastRun && !page.lastRun.ok
              ? <>The portal couldn&apos;t read QuickBooks just now{page.lastRun.detail ? `: ${page.lastRun.detail}` : "."} Open <Link href="/staff/roster">Roster</Link> and select <b>Refresh now</b> to try again, then come back.</>
              : page.lastRun
                ? <>QuickBooks has no customer types yet, so there is nothing to choose from. {MAKE_TYPES} Then open <Link href="/staff/roster">Roster</Link>, select <b>Refresh now</b>, and come back.</>
                : <>The portal hasn&apos;t read any customer types from QuickBooks yet. Open <Link href="/staff/roster">Roster</Link> and select <b>Refresh now</b>, then come back. If QuickBooks has no customer types: {MAKE_TYPES}</>}</Notice>
            : <ShapeForm types={page.types} shape={page.shape} preview={previewShapeAction} save={saveShapeAction} />}
          <p className="box-foot"><a href={`${SETUP}?step=connect`}>Back to step 2</a> · <a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
        </section>
      )}
    </main>
  );
}
