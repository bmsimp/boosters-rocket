import { requireParentPage } from "@/lib/guards";
import { EMAIL_COPY } from "@/lib/parents/email-change";
import { loadMySignin } from "@/lib/parents/signin-settings";
import { SIGNIN_SETTINGS_COPY, howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { getClubSettings } from "@/lib/settings/club";
import { env } from "@/env";
import { AskAgain, SetupLinkForm } from "../sign-in/signin-forms";
import { NewEmailForm } from "./email-forms";
import { Card, LinkButton, PageHeader } from "../../../components/ui";

export const metadata = { title: "Change your sign-in email" };

/** APP_URL's origin, where passkeys work: no secret, and the same for every visitor. */
const portalOrigin = () => new URL(env.APP_URL).origin;

/**
 * Where a parent asks to change the address they sign in with (src/lib/parents/email-change.ts). Whose address this is
 * comes from the session alone: the page's address has no id in it, and neither has the form.
 *
 * Offered to every parent while parent sign-ins are on and the session's own guardian row is open (canChangeMyEmail()),
 * in however many families they are. Anyone else is told to ask the club, and nothing more: not why. Since the
 * sign-in release's slice SI-5a the change is asked for only by a session that proved itself in the last 10 minutes
 * (open question 28): the page asks again first (src/lib/parents/asking-again.ts), and a person with no password is
 * offered a link to choose one; since SI-6b a guardian with an authenticator app is asked for its code, and since SI-7b
 * a guardian with a passkey for it (howYouSignIn()). Under Strict (since SI-10b) the change is asked here as at Standard,
 * by a session proved under Strict: the switch to Strict cleared every proof made before it.
 * The portal's own origin (APP_URL's, no secret) is passed to the asking, where a passkey works.
 */
export default async function FamilyEmailPage() {
  const ctx = await requireParentPage("/family/email");
  const [me, club] = await Promise.all([loadMySignin(ctx), getClubSettings()]);
  return (
    <main className="wrap single family-page">
      <PageHeader title="Change your sign-in email" lede={me.canChangeEmail
        ? <>You sign in with {ctx.email} now. A new address becomes your sign-in and updates the club&apos;s records too.</> : undefined} />
      {me.canChangeEmail ? (
        <Card title="Your new email" titleId="new-h">
          {!me.hasPassword ? (
              <>
                <p>{SIGNIN_SETTINGS_COPY.choosePasswordForEmail} {SIGNIN_SETTINGS_COPY.noPassword}</p>
                <SetupLinkForm />
              </>
            ) : (
              <AskAgain email={me.email} proved={me.provedRecently} lede={howYouSignIn({ app: me.app !== null, passkey: me.hasPasskey, strict: me.strict }).askAgainForEmail}
                passkey={me.hasPasskey} portalOrigin={portalOrigin()}>
                <p>We&apos;ll email a link to the new address. Nothing changes until you open it and say yes.</p>
                <NewEmailForm />
              </AskAgain>
            )}
        </Card>
      ) : (
        <Card title="Ask the club" titleId="ask-h" actions={<LinkButton plain variant="outlined" href="/family">Back to Family</LinkButton>}>
          <p className="help">{EMAIL_COPY.askTheClub}{club.treasurerEmail
            ? <> You can email the treasurer at <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a>.</> : null}</p>
        </Card>
      )}
    </main>
  );
}
