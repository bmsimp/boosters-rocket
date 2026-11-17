import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { getClubSettings } from "@/lib/settings/club";
import { clubSaved } from "@/lib/setup/club-step";
import { StateWords } from "@/app/components/state-words";
import { MailWarning } from "../../mail-warning";
import { seesMailWarning } from "../../mail-warning-rule";
import { BackToSettings } from "../back-to-settings";

export const metadata = { title: "Club settings" };
export const dynamic = "force-dynamic";

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). Changing it opens its own page. */
export default async function ClubSettingsPage() {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const [club, saved] = await Promise.all([getClubSettings(), clubSaved()]);
  const canChange = can(ctx.effective, "Settings.Club.ReadWrite");
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Club</h1>
      <p className="lede">The club&apos;s name and color are on every page, in every email and on the app parents put on their phones.</p>
      {seesMailWarning(ctx.effective) && <MailWarning canFix={can(ctx.effective, "Settings.Mail.ReadWrite")} />}
      <section className="box" aria-labelledby="club-h"><h2 id="club-h">What is set</h2>
        {!saved ? <StateWords state="todo" words="Not set yet: the portal still shows the name Booster Rocket" />
          : !club.storedColorValid ? <StateWords state="todo" words="The saved club color wasn't valid, so the portal is using the default purple. Pick a color and save to fix it." />
          : <StateWords state="done" words="Set" />}
        <dl className="details">
          <dt>Club name</dt><dd>{club.name}</dd>
          <dt>Short name</dt><dd>{club.shortName}</dd>
          <dt>Club color</dt><dd><span className="num">{club.color}</span>, the color of the bar at the top of this page</dd>
          <dt>Treasurer email</dt><dd>{club.treasurerEmail ?? "None"}</dd>
          <dt>Time zone</dt><dd>{club.timeZone.replaceAll("_", " ")}. It decides which day it is for a step&apos;s dates and a due date.</dd>
        </dl>
        {canChange ? <p className="settings-open"><a className="btn" href="/staff/settings/club/edit">Change</a></p>
          : <p className="hint">Only someone who may change club settings can change these.</p>}
      </section>
    </main>
  );
}
