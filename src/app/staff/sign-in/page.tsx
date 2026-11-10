import { getClubSettings } from "@/lib/settings/club";
import { loadProviders } from "@/lib/auth/providers";
import { SignInButton } from "./sign-in-button";

export const metadata = { title: "Staff sign in" };

export default async function StaffSignIn() {
  const club = await getClubSettings();
  const p = await loadProviders();
  const ms = Boolean(p.staffMicrosoft), google = Boolean(p.staffGoogle);
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name} staff</h1>
      <p className="lede">Sign in with the account the boosters added you with.</p>
      {ms && <SignInButton provider="microsoft" label="Sign in with Microsoft" primary />}
      {google && <SignInButton provider="google" label="Sign in with Google" primary={!ms} />}
      {!ms && !google && <p role="status">No staff sign-in is set up yet.</p>}
    </main>
  );
}
