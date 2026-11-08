import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubForm } from "./club-form";

export default async function ClubSettingsPage() {
  await requireStaffPage("Settings.Club.Read");
  return (
    <main className="wrap single">
      <h1 className="page-title">Club</h1>
      <section className="box" aria-labelledby="club-h"><h2 id="club-h">Name and colour</h2><ClubForm initial={await getClubSettings()} /></section>
    </main>
  );
}
