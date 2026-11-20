import { requireParentPage } from "@/lib/guards";
import { EMAIL_COPY } from "@/lib/parents/email-change";
import { loadMySignin } from "@/lib/parents/signin-settings";
import { SIGNIN_SETTINGS_COPY, howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { getClubSettings } from "@/lib/settings/club";
import { AskAgain, SetupLinkForm } from "../sign-in/signin-forms";
import { NewEmailForm } from "./email-forms";

export const metadata = { title: "Change your sign-in email" };

/**
 * Where a parent asks to change the address they sign in with (src/lib/parents/email-change.ts). Whose address this is
 * comes from the session alone: the page's address has no id in it, and neither has the form.
 *
 * Offered to every parent while parent sign-ins are on and the session's own guardian row is open (canChangeMyEmail()),
 * in however many families they are. Anyone else is told to ask the club, and nothing more: not why. Since the
 * sign-in release's slice SI-5a the change is asked for only by a session that proved itself in the last 10 minutes
 * (open question 28): the page asks again first (src/lib/parents/asking-again.ts), and a person with no password is
 * offered a link to choose one; since SI-6b a guardian with an authenticator app is asked for its code
 * (howYouSignIn()). Under Strict the change isn't made here yet, so the club is asked.
 */
export default async function FamilyEmailPage() {
  const ctx = await requireParentPage("/family/email");
  const [me, club] = await Promise.all([loadMySignin(ctx), getClubSettings()]);
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">Change your sign-in email</h1>
      {me.canChangeEmail ? (
        <>
          <p className="lede">You sign in with {ctx.email}. A new address becomes the one you sign in with, and the club&apos;s records are brought up to date with it.</p>
          <section className="box" aria-labelledby="new-h">
            <h2 id="new-h">Your new email</h2>
            {me.strict ? <p>{SIGNIN_SETTINGS_COPY.strict}</p>
              : !me.hasPassword ? (
                <>
                  <p>{SIGNIN_SETTINGS_COPY.choosePasswordForEmail} {SIGNIN_SETTINGS_COPY.noPassword}</p>
                  <SetupLinkForm />
                </>
              ) : (
                <AskAgain email={me.email} proved={me.provedRecently} lede={howYouSignIn(me.app !== null).askAgainForEmail}>
                  <p>We&apos;ll email a link to the new address. Nothing changes until you open it and say yes.</p>
                  <NewEmailForm />
                </AskAgain>
              )}
          </section>
        </>
      ) : (
        <section className="box" aria-labelledby="ask-h">
          <h2 id="ask-h">Ask the club</h2>
          <p className="help">{EMAIL_COPY.askTheClub}{club.treasurerEmail
            ? <> You can email the treasurer at <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a>.</> : null}</p>
          <div className="box-foot"><a className="btn btn-line" href="/family">Back to Family</a></div>
        </section>
      )}
    </main>
  );
}
