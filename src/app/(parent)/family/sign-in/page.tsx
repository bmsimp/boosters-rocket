import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { loadMySignin } from "@/lib/parents/signin-settings";
import { SIGNIN_SETTINGS_COPY as COPY, howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { AskAgain, ChangePasswordForm, RememberedDevices, SetupLinkForm, SignInSettingsFrame, SignOutEverywhereForm } from "./signin-forms";
import { AuthenticatorBox } from "./authenticator-box";

export const metadata = { title: "Sign-in settings" };

/**
 * A parent's sign-in settings (the sign-in release, slice SI-5a): how they sign in, their password, and signing out
 * everywhere. Reached from the Family page's "Your account" box, never a tab. Everything is read through the session's
 * own person (loadMySignin(), src/lib/parents/signin-settings.ts): the page's address has no id in it, and neither has
 * any form. Changing the password asks again first (src/lib/parents/asking-again.ts) unless this session proved itself
 * in the last 10 minutes, and so does forgetting a remembered device (SI-5b), whose list shows only what the portal
 * keeps of each: when it was first remembered and last used, and which this session was made on. Since SI-6b the
 * "Authenticator app" box sets one up (asked again first), shows its backup codes once, makes new ones and turns it
 * off (AuthenticatorBox); the words that say how the parent signs in on a new device follow whether they have one
 * (howYouSignIn(), by the loader's `app`). Passkeys come in SI-7.
 * Once a press signs the parent out everywhere, the frame (SignInSettingsFrame) draws its answer in place of every form.
 */
export default async function SignInSettingsPage() {
  const ctx = await requireParentPage("/family/sign-in");
  const me = await loadMySignin(ctx);
  // The sentences of how the parent signs in on a new device: the code from their authenticator app, or the code we email.
  const words = howYouSignIn(me.app !== null);
  // How a parent signs in again after signing out everywhere: with their password; with none yet, after choosing one
  // from "Set up or reset my password"; with none under Strict, where nothing is mailed on request, only with the club.
  const again = me.hasPassword ? { then: words.everywhereThen, next: words.everywhereNext, signIn: { href: "/sign-in", label: COPY.signIn } }
    : me.strict ? { then: COPY.everywhereThenStrict, next: COPY.everywhereNextStrict, signIn: null }
    : { then: COPY.everywhereThenNoPassword, next: COPY.everywhereNextNoPassword, signIn: { href: "/sign-in/password", label: COPY.choosePassword } };
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">{COPY.title}</h1>
      <p className="lede">{COPY.lede}</p>
      <SignInSettingsFrame>
        <section className="box" aria-labelledby="how-h">
          <h2 id="how-h">{COPY.howTitle}</h2>
          <dl className="details">
            <dt>{COPY.email}</dt><dd>{me.email}</dd>
            <dt>{COPY.password}</dt><dd>{me.hasPassword ? COPY.passwordChosen : COPY.passwordNotChosen}</dd>
          </dl>
          <p className="help">{me.hasPassword ? words.how : COPY.howNoPassword}</p>
          {/* No id in the link: the page takes whose address it is from the session. Under Strict it can't be changed here. */}
          {me.canChangeEmail && !me.strict && <div className="box-foot"><Link className="btn btn-line" href="/family/email">{COPY.changeEmail}</Link></div>}
        </section>
        <section className="box" aria-labelledby="password-h">
          <h2 id="password-h">{COPY.passwordTitle}</h2>
          {me.strict ? <p>{COPY.strict}</p>
            : !me.hasPassword ? <><p>{COPY.noPassword}</p><SetupLinkForm /></>
            : (
              <AskAgain email={me.email} proved={me.provedRecently} lede={words.askAgainForPassword}>
                <ChangePasswordForm email={me.email} app={me.app !== null} />
              </AskAgain>
            )}
        </section>
        <section className="box" aria-labelledby="everywhere-h">
          <h2 id="everywhere-h">{COPY.everywhereTitle}</h2>
          <SignOutEverywhereForm then={again.then} next={again.next} signIn={again.signIn} />
        </section>
        <section className="box" aria-labelledby="devices-h">
          <h2 id="devices-h">{COPY.devicesTitle}</h2>
          {/* Each device is given only its row's id, whether it is this session's, and its two times. */}
          <RememberedDevices devices={me.devices} proved={me.provedRecently} email={me.email} app={me.app !== null}
            canAsk={me.hasPassword && !me.strict} cantAsk={me.strict ? COPY.devicesStrict : COPY.choosePasswordForDevices} />
        </section>
        <section className="box" aria-labelledby="app-h">
          <h2 id="app-h">{COPY.appTitle}</h2>
          {/* Given the app's two facts and nothing else of it: the key, the QR code and the backup codes come only in a press's answer. */}
          <AuthenticatorBox email={me.email} app={me.app} proved={me.provedRecently} hasPassword={me.hasPassword} strict={me.strict} />
        </section>
        <p><Link className="link-line" href="/family">Back to Family</Link></p>
      </SignInSettingsFrame>
    </main>
  );
}
