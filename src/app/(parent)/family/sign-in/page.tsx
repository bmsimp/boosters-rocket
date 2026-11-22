import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { loadMySignin } from "@/lib/parents/signin-settings";
import { SIGNIN_SETTINGS_COPY as COPY, howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { AskAgain, ChangePasswordForm, RememberedDevices, SetupLinkForm, SignInSettingsFrame, SignOutEverywhereForm } from "./signin-forms";
import { AuthenticatorBox } from "./authenticator-box";
import { PasskeyBox } from "./passkey-box";
import { env } from "@/env";
import { Card, KeyValue, LinkButton, PageHeader } from "../../../components/ui";

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
 * (howYouSignIn(), by the loader's `app`). Since SI-7b the "Passkeys" box adds (asked again first), names, lists and
 * removes passkeys (PasskeyBox), a passkey holder is asked again with the passkey, and the words follow whether they
 * have one too (`hasPasskey`). Since SI-10b everything here works at Strict as at Standard (the switch to Strict
 * cleared every older proof), with Strict's words of how they sign in (`strict`) and, under new backup codes, a confirm
 * that they were saved. APP_URL's origin, where passkeys work, is passed to the forms (no secret).
 * Once a press signs the parent out everywhere, the frame (SignInSettingsFrame) draws its answer in place of every form.
 */
export default async function SignInSettingsPage() {
  const ctx = await requireParentPage("/family/sign-in");
  const me = await loadMySignin(ctx);
  // The sentences of how the parent signs in on a new device: the code from their authenticator app, or the code we email.
  const factors = { app: me.app !== null, passkey: me.hasPasskey, strict: me.strict };
  const words = howYouSignIn(factors);
  const portalOrigin = new URL(env.APP_URL).origin;
  // How a parent signs in again after signing out everywhere: with their password; with none yet, after choosing one
  // from "Set up or reset my password"; with none under Strict, where nothing is mailed on request, only with the club.
  const again = me.hasPassword ? { then: words.everywhereThen, next: words.everywhereNext, signIn: { href: "/sign-in", label: COPY.signIn } }
    : me.strict ? { then: COPY.everywhereThenStrict, next: COPY.everywhereNextStrict, signIn: null }
    : { then: COPY.everywhereThenNoPassword, next: COPY.everywhereNextNoPassword, signIn: { href: "/sign-in/password", label: COPY.choosePassword } };
  return (
    <main className="wrap single family-page">
      <PageHeader title={COPY.title} lede={COPY.lede} />
      <SignInSettingsFrame>
        {/* No id in the link: the page takes whose address it is from the session. */}
        <Card title={COPY.howTitle} titleId="how-h" actions={me.canChangeEmail && <LinkButton variant="secondary" href="/family/email">{COPY.changeEmail}</LinkButton>}>
          <KeyValue items={[
            { key: "email", label: COPY.email, value: me.email },
            { key: "password", label: COPY.password, value: me.hasPassword ? COPY.passwordChosen : COPY.passwordNotChosen },
          ]} />
          <p className="help">{me.hasPassword ? words.how : COPY.howNoPassword}</p>
        </Card>
        <Card title={COPY.passwordTitle} titleId="password-h">
          {!me.hasPassword ? <><p>{COPY.noPassword}</p><SetupLinkForm /></>
            : (
              <AskAgain email={me.email} proved={me.provedRecently} lede={words.askAgainForPassword} passkey={me.hasPasskey} portalOrigin={portalOrigin}>
                <ChangePasswordForm email={me.email} app={me.app !== null} passkey={me.hasPasskey} strict={me.strict} />
              </AskAgain>
            )}
        </Card>
        <Card title={COPY.everywhereTitle} titleId="everywhere-h">
          <SignOutEverywhereForm then={again.then} next={again.next} signIn={again.signIn} />
        </Card>
        <Card title={COPY.devicesTitle} titleId="devices-h">
          {/* Each device is given only its row's id, whether it is this session's, and its two times. */}
          <RememberedDevices devices={me.devices} proved={me.provedRecently} email={me.email} app={me.app !== null} passkey={me.hasPasskey} strict={me.strict}
            portalOrigin={portalOrigin} canAsk={me.hasPassword} cantAsk={COPY.choosePasswordForDevices} />
        </Card>
        <Card title={COPY.appTitle} titleId="app-h">
          {/* Given the app's two facts and nothing else of it: the key, the QR code and the backup codes come only in a press's answer. */}
          <AuthenticatorBox email={me.email} app={me.app} proved={me.provedRecently} hasPassword={me.hasPassword} strict={me.strict}
            passkey={me.hasPasskey} portalOrigin={portalOrigin} />
        </Card>
        <Card title={COPY.passkeysTitle} titleId="passkeys-h">
          {/* Each passkey is given only its row's id, its name and its two times: never a credential id, a key or the device's type. */}
          <PasskeyBox email={me.email} passkeys={me.passkeys} proved={me.provedRecently} hasPassword={me.hasPassword} strict={me.strict}
            app={me.app !== null} backupCodesLeft={me.backupCodesLeft} portalOrigin={portalOrigin} />
        </Card>
        <p><Link className="link-line" href="/family">Back to Family</Link></p>
      </SignInSettingsFrame>
    </main>
  );
}
