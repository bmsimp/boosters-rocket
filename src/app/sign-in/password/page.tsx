import { getClubSettings } from "@/lib/settings/club";
import { mailWorking } from "@/lib/mail/settings";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { SIGNIN_UNAVAILABLE } from "@/lib/parents/signin-copy";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { ClubBar } from "@/app/components/club-bar";
import { PasswordRequestForm } from "../password-request-form";

export const metadata = { title: "Set up or reset my password" };
export const dynamic = "force-dynamic";

/**
 * "Set up or reset my password" (the sign-in release, slice SI-3a), linked from /sign-in. No session and no token: its
 * guard is its limits and its one answer (askPasswordLinkAction, ../password-actions.ts). It is ready when /sign-in is
 * (mail working, parent sign-ins on); otherwise it says sign-in isn't available, with no form. Opening it writes
 * nothing. It shows nothing about a person or a family; the form is given plain words and whether the club is at
 * Strict, where nothing is mailed on request yet and the page tells everyone to ask the club.
 */
export default async function PasswordRequestPage() {
  const [club, mail, settings] = await Promise.all([getClubSettings(), mailWorking(), getParentSettings()]);
  const ready = mail && !parentDoorClosed(settings);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={[]} />
      <main className="wrap signin">
        <h1 className="page-title">{PASSWORD_COPY.askTitle}</h1>
        {ready ? <PasswordRequestForm strict={settings.level === "strict"} /> : <p role="status">{SIGNIN_UNAVAILABLE}</p>}
        <p><a className="link-line" href="/sign-in">Back to sign in</a></p>
      </main>
    </>
  );
}
