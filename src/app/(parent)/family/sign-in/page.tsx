import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { loadMySignin } from "@/lib/parents/signin-settings";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { AskAgain, ChangePasswordForm, SetupLinkForm, SignOutEverywhereForm } from "./signin-forms";

export const metadata = { title: "Sign-in settings" };

/**
 * A parent's sign-in settings (the sign-in release, slice SI-5a): how they sign in, their password, and signing out
 * everywhere. Reached from the Family page's "Your account" box, never a tab. Everything is read through the session's
 * own person (loadMySignin(), src/lib/parents/signin-settings.ts): the page's address has no id in it, and neither has
 * any form. Changing the password asks again first (src/lib/parents/asking-again.ts) unless this session proved itself
 * in the last 10 minutes. The device list, and forgetting a device, come in SI-5b; more ways to sign in in SI-6 and SI-7.
 */
export default async function SignInSettingsPage() {
  const ctx = await requireParentPage("/family/sign-in");
  const me = await loadMySignin(ctx);
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">{COPY.title}</h1>
      <p className="lede">{COPY.lede}</p>
      <section className="box" aria-labelledby="how-h">
        <h2 id="how-h">{COPY.howTitle}</h2>
        <dl className="details">
          <dt>{COPY.email}</dt><dd>{me.email}</dd>
          <dt>{COPY.password}</dt><dd>{me.hasPassword ? COPY.passwordChosen : COPY.passwordNotChosen}</dd>
        </dl>
        <p className="help">{COPY.how}</p>
        {/* No id in the link: the page takes whose address it is from the session. */}
        {me.canChangeEmail && <div className="box-foot"><Link className="btn btn-line" href="/family/email">{COPY.changeEmail}</Link></div>}
      </section>
      <section className="box" aria-labelledby="password-h">
        <h2 id="password-h">{COPY.passwordTitle}</h2>
        {me.strict ? <p>{COPY.strict}</p>
          : !me.hasPassword ? <><p>{COPY.noPassword}</p><SetupLinkForm /></>
          : (
            <AskAgain email={me.email} proved={me.provedRecently} lede={COPY.askAgainForPassword}>
              <ChangePasswordForm email={me.email} />
            </AskAgain>
          )}
      </section>
      <section className="box" aria-labelledby="everywhere-h">
        <h2 id="everywhere-h">{COPY.everywhereTitle}</h2>
        <SignOutEverywhereForm />
      </section>
      <section className="box" aria-labelledby="devices-h">
        <h2 id="devices-h">{COPY.devicesTitle}</h2>
        <p>{COPY.devicesSoon}</p>
      </section>
      <section className="box" aria-labelledby="more-h">
        <h2 id="more-h">{COPY.moreTitle}</h2>
        <p>{COPY.moreSoon}</p>
      </section>
      <p><Link className="link-line" href="/family">Back to Family</Link></p>
    </main>
  );
}
