import { getClubSettings } from "@/lib/settings/club";
import { staffEntraEnabled, staffGoogleEnabled } from "@/env";
import { SignInButton } from "../../sign-in/sign-in-button";

export const metadata = { title: "Staff sign in" };

export default async function StaffSignIn() {
  const club = await getClubSettings();
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name} staff</h1>
      <p className="lede">Sign in with the account the boosters added you with.</p>
      {staffEntraEnabled && <SignInButton door="staff" provider="microsoft" label="Sign in with Microsoft" primary />}
      {staffGoogleEnabled && <SignInButton door="staff" provider="google" label="Sign in with Google" primary={!staffEntraEnabled} />}
      {!staffEntraEnabled && !staffGoogleEnabled && <p role="status">No staff sign-in is set up yet.</p>}
    </main>
  );
}
