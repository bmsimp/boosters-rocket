import Link from "next/link";
import { requireParentPage } from "@/lib/guards";
import { canChangeMyEmail } from "@/lib/parents/email-change";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { DetailsBox, NotSetUpBox, RosterAsOf, StudentsBox } from "../family-boxes";

export const metadata = { title: "Family" };

export default async function FamilyPage() {
  const ctx = await requireParentPage("/family");
  const [family, club, ownEmail] = await Promise.all([loadMyFamily(ctx), getClubSettings(), canChangeMyEmail(ctx)]);
  return (
    <main className="wrap single family-page">
      <h1 className="page-title">{family ? family.name : "Your family"}</h1>
      {family ? (
        <>
          {family.students && <StudentsBox students={family.students} />}
          <DetailsBox who={family.me ?? { name: ctx.name, email: ctx.email, phone: null }} treasurerEmail={club.treasurerEmail} ownEmail={ownEmail && "below"} />
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
        <p className="help">You sign in with this address and your password. On a device we don&apos;t know yet, we also email a code to this address.</p>
        {/* No id in the link: the page takes whose address it is from the session. */}
        {ownEmail && <div className="box-foot"><Link className="btn btn-line" href="/family/email">Change my sign-in email</Link></div>}
      </section>
      {family && <RosterAsOf family={family} />}
    </main>
  );
}
