import { requireParentPage } from "@/lib/guards";
import { EMAIL_COPY, findMyEmailChange } from "@/lib/parents/email-change";
import { ConfirmEmailForm } from "../email-forms";

export const metadata = { title: "Your new sign-in email" };
// Each open looks the link up again: a link is spent, or runs out, between one open and the next.
export const dynamic = "force-dynamic";

/**
 * The page the link in the email opens. A parent who must sign in first (with the address they use now) is brought
 * back here. Opening it changes nothing, since mail scanners open links too: it asks, and the button makes the change.
 *
 * The token in the address is untrusted. findMyEmailChange() looks it up among the session's own requests only, made
 * under the session's own family and link; any other token gets the words of a link that has expired, whatever the
 * reason, and nothing of anyone else's request is shown.
 */
export default async function ConfirmEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await requireParentPage(`/family/email/${token}`);
  const view = await findMyEmailChange(ctx, token);
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">Your sign-in email</h1>
      <section className="box" aria-labelledby="confirm-h">
        {view.state === "ask" ? (
          <>
            <h2 id="confirm-h">{`Use ${view.newEmail} to sign in from now on?`}</h2>
            <p>You sign in with {ctx.email} now. Once you say yes, you sign in again with the new address, and the club&apos;s records are brought up to date with it.</p>
            <ConfirmEmailForm token={token} />
          </>
        ) : (
          <>
            <h2 id="confirm-h">{view.state === "ask_club" ? "Ask the club" : "This link can't be used"}</h2>
            <p className="help">{view.state === "ask_club" ? EMAIL_COPY.askTheClub : EMAIL_COPY.linkNoGood}</p>
            <div className="box-foot"><a className="btn btn-line" href="/family">Back to Family</a></div>
          </>
        )}
      </section>
    </main>
  );
}
