import { getClubSettings } from "@/lib/settings/club";
import { loadProviders } from "@/lib/auth/providers";
import { ClubBar } from "@/app/components/club-bar";
import { SignInButton } from "./sign-in-button";
import { Notice } from "@/app/components/notice";
import { PoweredBy } from "@/app/components/powered-by";

export const metadata = { title: "Staff sign in" };

export default async function StaffSignIn() {
  const club = await getClubSettings();
  const p = await loadProviders();
  const ms = Boolean(p.staffMicrosoft), google = Boolean(p.staffGoogle);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={[]} />
      <main className="wrap signin">
        <h1 className="page-title">Staff sign in</h1>
        <p className="lede">Sign in with the account the boosters added you with.</p>
        {ms && <SignInButton provider="microsoft" label="Sign in with Microsoft" primary />}
        {google && <SignInButton provider="google" label="Sign in with Google" primary={!ms} />}
        {!ms && !google && <Notice tone="info">No staff sign-in is set up yet.</Notice>}
      </main>
      <footer className="signin-foot"><PoweredBy variant="color" /></footer>
    </>
  );
}
