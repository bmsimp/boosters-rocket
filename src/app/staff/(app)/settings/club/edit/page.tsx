import { requireStaffPage } from "@/lib/guards";
import { getClubSettings, timeZoneChoices } from "@/lib/settings/club";
import { ClubForm } from "@/app/components/club-settings/club-form";
import { saveClubAction } from "../actions";

export const metadata = { title: "Change club settings" };
export const dynamic = "force-dynamic";

export default async function ClubEditPage() {
  await requireStaffPage("Settings.Club.ReadWrite");
  const club = await getClubSettings();
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/club">Back to club settings</a></p>
      <h1 className="page-title">Change club settings</h1>
      <section className="box" aria-labelledby="club-h"><h2 id="club-h">Name, color and time zone</h2>
        <ClubForm withTreasurer submit="Save" save={saveClubAction} timeZones={timeZoneChoices(club.timeZone)}
          initial={{ name: club.name, shortName: club.shortName, color: club.color, treasurerEmail: club.treasurerEmail ?? "", timeZone: club.timeZone }} />
      </section>
    </main>
  );
}
