import { getClubSettings } from "@/lib/settings/club";
import { parentDoorEnabled } from "@/env";
import { PARENT_PROVIDER_ID } from "@/lib/auth/parent-auth";
import { SignInButton } from "./sign-in-button";

export const metadata = { title: "Sign in" };

export default async function ParentSignIn() {
  const club = await getClubSettings();
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      <p className="lede">Sign in to see your students, what&apos;s owed, and this season&apos;s forms. We&apos;ll email you a code; check your spam folder if it doesn&apos;t arrive in a minute.</p>
      {parentDoorEnabled
        ? <SignInButton door="parent" provider={PARENT_PROVIDER_ID} label="Sign in with your email" primary />
        : <p role="status">Sign-in isn&apos;t set up yet. Please check back soon.</p>}
      <p className="lede"><a href="/staff/sign-in">Board and staff sign in here</a></p>
    </main>
  );
}
