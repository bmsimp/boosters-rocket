import { requireEnrolmentPage } from "@/lib/guards";
import { RETURN_PARAM, safeReturnPath } from "@/lib/auth/return-path";
import { ENROLMENT_COPY as WORDS } from "@/lib/parents/enrolment-copy";
import { SignOutButton } from "@/app/components/sign-out-button";
import { env } from "@/env";
import { confirmEnrolmentAppAction, startEnrolmentAppAction } from "./actions";
import { EnrolmentSteps } from "./enrolment-steps";

export const metadata = { title: WORDS.title };
export const dynamic = "force-dynamic";

type Query = Record<string, string | string[] | undefined>;

/**
 * Strict's enrolment (the sign-in release, slice SI-10a; open questions 21, 22 and 25 of the app-owned families spec):
 * the one page an enrolling session reaches, a session a password alone made under Strict for a person with neither a
 * passkey nor an authenticator app. Outside src/app/(parent)/, in the chooser's frame (no club bar, no tabs): its guard
 * is requireEnrolmentPage() (src/lib/guards.ts), which sends a whole session home and no session to sign in. It draws
 * two boxes, a passkey and an authenticator app (EnrolmentSteps), and the sign-out press at its foot. Given only
 * APP_URL's origin (where passkeys work), the actions bound here and `next` as the address carried it, through
 * safeReturnPath(): never the address the person signs in with, a name, a family or a count. Opening it writes nothing.
 */
export default async function OneMoreStep({ searchParams }: { searchParams?: Promise<Query> } = {}) {
  const ctx = await requireEnrolmentPage();
  void ctx; // the guard is all this page needs of the session: the presses read whose it is from the session themselves
  const query = await searchParams;
  const next = safeReturnPath(query?.[RETURN_PARAM]);
  const portalOrigin = new URL(env.APP_URL).origin;
  return (
    <main className="wrap signin">
      <h1 className="page-title">{WORDS.title}</h1>
      <p className="lede">{WORDS.lede}</p>
      <EnrolmentSteps portalOrigin={portalOrigin} next={next} startApp={startEnrolmentAppAction} confirmApp={confirmEnrolmentAppAction} />
      <p className="help">{WORDS.foot}</p>
      <SignOutButton door="parent" />
    </main>
  );
}
