import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubForm } from "./club-form";

export default async function ClubSettingsPage() {
  await requireStaffPage("Settings.Club.Read");
  const club = await getClubSettings();
  return (
    <main className="wrap single">
      <h1 className="page-title">Club</h1>
      {!club.storedColorValid && (
        <p role="status" className="box">The saved club color wasn&apos;t valid, so the portal is using the default purple. Pick a color and save to fix it.</p>
      )}
      <section className="box" aria-labelledby="club-h"><h2 id="club-h">Name and color</h2><ClubForm initial={club} /></section>
    </main>
  );
}
