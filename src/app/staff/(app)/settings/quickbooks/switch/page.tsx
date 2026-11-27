import { Button, LinkButton } from "@/app/components/ui";
import { redirect } from "next/navigation";
import { Notice } from "@/app/components/notice";
import { requireStaffPage } from "@/lib/guards";
import { switchPreview } from "@/lib/quickbooks/switch";
import { switchConnectAction } from "../actions";
import { WhichQuickBooks } from "../forms";
import { SWITCH_WORDS } from "../switch-words";

export const metadata = { title: SWITCH_WORDS.title };
export const dynamic = "force-dynamic";

const SETUP = "/staff/settings/quickbooks/setup";

/**
 * Before a different QuickBooks company is connected (stage 4's slice M8, the owner's choice 1): what a switch ends and
 * keeps, in counts, and the one press that sends an Admin to Intuit with an ask recorded (beginSwitchConnect()). A step
 * page, as the setup page is: no menu entry and no settings section. While QuickBooks is connected it says to
 * disconnect first and offers no press; while the roster names no company there is nothing to switch from, and it
 * sends the visitor to step 2. Through Boosters Rocket the press is sent with the QuickBooks chosen here, the real books
 * or a sandbox company, the saved one chosen first (the owner's finding of 2026-11-25); with the club's own Intuit app
 * it says which one the app's keys are for and that step 1 changes it. Not audited: it counts every family and names none.
 */
export default async function SwitchCompanyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const sp = await searchParams;
  const p = await switchPreview();
  if (!p.rosterNamesCompany) redirect(`${SETUP}?step=connect`);
  const notConfirmed = sp.error === "confirm", noEnvironment = sp.error === "environment";
  const relay = p.connectMode === "relay";
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
      <h1 className="page-title">{SWITCH_WORDS.title}</h1>
      <p className="lede">{SWITCH_WORDS.lede}</p>

      <section className="box" aria-labelledby="switch-ends-h"><h2 id="switch-ends-h">{SWITCH_WORDS.endsTitle}</h2>
        <ul className="notice-list">{SWITCH_WORDS.ends(p).map((w) => <li key={w}>{w}</li>)}</ul>
      </section>

      <section className="box" aria-labelledby="switch-kept-h"><h2 id="switch-kept-h">{SWITCH_WORDS.keptTitle}</h2>
        <ul className="notice-list">{SWITCH_WORDS.kept(p).map((w) => <li key={w}>{w}</li>)}</ul>
      </section>

      <section className="box" aria-labelledby="switch-start-h"><h2 id="switch-start-h">{SWITCH_WORDS.backupTitle}</h2>
        <p>{SWITCH_WORDS.backup}</p>
        {p.connected
          ? <Notice tone="warning">{SWITCH_WORDS.disconnectFirst} <LinkButton variant="tonal" size="sm" href="/staff/settings/quickbooks">QuickBooks settings</LinkButton></Notice>
          : (
            <form action={switchConnectAction} className="stack">
              {notConfirmed && <Notice tone="problem">{SWITCH_WORDS.notConfirmed}</Notice>}
              {noEnvironment && relay && <Notice tone="problem">{SWITCH_WORDS.chooseEnvironment}</Notice>}
              {relay
                ? <WhichQuickBooks environment={p.environment} />
                : <><p>{SWITCH_WORDS.ownAppEnvironment(p.environment)}</p>
                  <p><LinkButton variant="outlined" href={`${SETUP}?step=app`}>{SWITCH_WORDS.ownAppLink}</LinkButton></p></>}
              <fieldset className="checks"><legend>Confirm</legend>
                <label><input type="checkbox" name="confirm" value="yes" required /> {SWITCH_WORDS.confirm}</label>
              </fieldset>
              <Button type="submit">{SWITCH_WORDS.press}</Button>
            </form>
          )}
        <p className="box-foot"><LinkButton variant="outlined" href={`${SETUP}?step=connect`}>Back to step 2</LinkButton></p>
      </section>
    </main>
  );
}
