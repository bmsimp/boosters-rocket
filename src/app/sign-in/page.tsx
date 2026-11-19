import { getClubSettings } from "@/lib/settings/club";
import { mailWorking } from "@/lib/mail/settings";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { SIGNIN_UNAVAILABLE } from "@/lib/parents/signin-copy";
import { RETURN_PARAM, safeReturnPath } from "@/lib/auth/return-path";
import { ClubBar } from "@/app/components/club-bar";
import { InstallHint } from "@/app/components/pwa/install-hint";
import { PasswordSignIn } from "./password-sign-in";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

type Query = Record<string, string | string[] | undefined>;

export default async function ParentSignIn({ searchParams }: { searchParams?: Promise<Query> }) {
  const [club, mail, settings, query] = await Promise.all([getClubSettings(), mailWorking(), getParentSettings(), searchParams]);
  const ready = mail && !parentDoorClosed(settings);
  // The page the parent asked for (requireParentPage). Anyone can write this page's address, so only a parent page of
  // this site gets through, and the portal checks it again when the sign-in finishes.
  const next = safeReturnPath(query?.[RETURN_PARAM]);
  // From the link that confirms a new sign-in address: the new one doesn't work until that is confirmed.
  const confirmingEmail = next?.startsWith("/family/email/") ?? false;
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={[]} />
      <main className="wrap signin">
        <h1 className="page-title">Sign in</h1>
        {ready && confirmingEmail && <p className="help">To confirm your new email, sign in with the address you use now. The new one works once the change is confirmed.</p>}
        {ready ? <PasswordSignIn next={next} /> : <p role="status">{SIGNIN_UNAVAILABLE}</p>}
        {/* A set-up link for a first password, or a reset link for a forgotten one (./password, slice SI-3a). */}
        {ready && <p><a className="link-line" href="/sign-in/password">Set up or reset my password</a></p>}
        <p className="lede"><a className="link-line" href="/staff/sign-in">Board and staff sign in here</a></p>
        {/* How to put the portal on the home screen. It takes nothing from the server, and "Not now" puts it away on this device. */}
        <InstallHint />
      </main>
    </>
  );
}
