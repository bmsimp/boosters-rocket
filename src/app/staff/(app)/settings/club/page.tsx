import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { getClubSettings, timeZoneChoices } from "@/lib/settings/club";
import { MailWarning } from "../../mail-warning";
import { seesMailWarning } from "../../mail-warning-rule";
import { ClubForm } from "./club-form";

export default async function ClubSettingsPage() {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const club = await getClubSettings();
  return (
    <main className="wrap single">
      <h1 className="page-title">Club</h1>
      {seesMailWarning(ctx.effective) && <MailWarning canFix={can(ctx.effective, "Settings.Mail.ReadWrite")} />}
      {!club.storedColorValid && (
        <p role="status" className="box">The saved club color wasn&apos;t valid, so the portal is using the default purple. Pick a color and save to fix it.</p>
      )}
      <section className="box" aria-labelledby="club-h"><h2 id="club-h">Name, color and time zone</h2>
        <ClubForm initial={{ name: club.name, shortName: club.shortName, color: club.color, treasurerEmail: club.treasurerEmail, timeZone: club.timeZone }} timeZones={timeZoneChoices(club.timeZone)} /></section>
    </main>
  );
}
