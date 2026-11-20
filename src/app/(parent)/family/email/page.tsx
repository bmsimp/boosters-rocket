import { requireParentPage } from "@/lib/guards";
import { EMAIL_COPY, canChangeMyEmail } from "@/lib/parents/email-change";
import { getClubSettings } from "@/lib/settings/club";
import { NewEmailForm } from "./email-forms";

export const metadata = { title: "Change your sign-in email" };

/**
 * Where a parent asks to change the address they sign in with (src/lib/parents/email-change.ts). Whose address this is
 * comes from the session alone: the page's address has no id in it, and neither has the form.
 *
 * Offered to every parent while parent sign-ins are on and the session's own guardian row is open (canChangeMyEmail()),
 * in however many families they are. Anyone else is told to ask the club, and nothing more: not why.
 */
export default async function FamilyEmailPage() {
  const ctx = await requireParentPage("/family/email");
  const [may, club] = await Promise.all([canChangeMyEmail(ctx), getClubSettings()]);
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">Change your sign-in email</h1>
      {may ? (
        <>
          <p className="lede">You sign in with {ctx.email}. A new address becomes the one you sign in with, and the club&apos;s records are brought up to date with it.</p>
          <section className="box" aria-labelledby="new-h">
            <h2 id="new-h">Your new email</h2>
            <p>We&apos;ll email a link to the new address. Nothing changes until you open it and say yes.</p>
            <NewEmailForm />
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
