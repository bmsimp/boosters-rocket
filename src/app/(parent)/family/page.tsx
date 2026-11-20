import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { canChangeMyEmail } from "@/lib/parents/email-change";
import { hasAuthenticator } from "@/lib/parents/authenticator";
import { howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { DetailsBox, NotSetUpBox, StudentsBox } from "../family-boxes";

export const metadata = { title: "Family" };

export default async function FamilyPage() {
  const ctx = await requireParentPage("/family");
  const [family, club, ownEmail, app] = await Promise.all([loadMyFamily(ctx), getClubSettings(), canChangeMyEmail(ctx), hasAuthenticator(ctx.parentId)]);
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">{family ? family.name : "Your family"}</h1>
      {family ? (
        <>
          {family.students && <StudentsBox students={family.students} />}
          <DetailsBox who={family.me} treasurerEmail={club.treasurerEmail} ownEmail={ownEmail && "below"} />
        </>
      ) : <NotSetUpBox treasurerEmail={club.treasurerEmail} />}
      {ctx.families.length > 1 && (
        // Only the family being viewed is named here; the chooser lists the others.
        <section className="box" aria-labelledby="fams-h">
          <h2 id="fams-h">Your families</h2>
          <p>You&apos;re a guardian in {ctx.families.length} families.{family ? <> You&apos;re looking at {family.name} now.</> : null}</p>
          <div className="box-foot"><a className="btn btn-line" href="/choose-family">Switch family</a></div>
        </section>
      )}
      <section className="box" aria-labelledby="acct-h">
        <h2 id="acct-h">Your account</h2>
        <p>How you sign in to the portal</p>
        <dl className="details">
          <dt>Name</dt><dd>{ctx.name}</dd>
          <dt>Email</dt><dd>{ctx.email}</dd>
        </dl>
        {/* How they sign in on a new device: the code from their authenticator app (since SI-6b), or the code we email. */}
        <p className="help">{howYouSignIn(app).how}</p>
        {/* No id in either link: each page takes whose sign-in it is from the session. */}
        <div className="box-foot stack">
          <Link className="btn btn-line" href="/family/sign-in">Sign-in settings</Link>
          {ownEmail && <Link className="btn btn-line" href="/family/email">Change my sign-in email</Link>}
        </div>
      </section>
    </main>
  );
}
