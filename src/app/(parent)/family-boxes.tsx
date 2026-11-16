import type { MyContact, MyFamily, MyStudent } from "@/lib/parents/my-family";
import { LocalTime } from "../components/local-time";

/**
 * The boxes Home and Family share. Server components: every name, address and number here is QuickBooks text or the
 * person's own, written as text only.
 */

export function StudentsBox({ students }: { students: MyStudent[] }) {
  return (
    <section className="box students-box" aria-labelledby="stu-h">
      <h2 id="stu-h">Your students</h2>
      {students.length > 0 ? (
        <ul className="students">
          {students.map((s) => <li key={s.qboId}><span className="who"><b>{s.name}</b></span></li>)}
        </ul>
      ) : <p>The club has no active students listed for your family right now.</p>}
    </section>
  );
}

/** How to reach the club about a change: the treasurer's address when the club has set one. */
function AskTheClub({ treasurerEmail }: { treasurerEmail: string | null }) {
  return treasurerEmail
    ? <>Email the treasurer at <a href={`mailto:${treasurerEmail}`}>{treasurerEmail}</a> and they&apos;ll update it.</>
    : <>Ask the club and they&apos;ll update it.</>;
}

/**
 * The person's own name, email and phone as QuickBooks has them, or as the portal knows them when their sign-in has no
 * QuickBooks record. A QuickBooks record (`who.edits`, set by loadMyFamily) gets the way to the page where its phone
 * and address are changed; the link carries no id, because that page takes the record from the session.
 */
export function DetailsBox({ who, treasurerEmail }: { who: MyContact; treasurerEmail: string | null }) {
  return (
    <section className="box details-box" aria-labelledby="det-h">
      <h2 id="det-h">Your details</h2>
      <p>How the club reaches you</p>
      <dl className="details">
        <dt>Name</dt><dd>{who.name}</dd>
        {who.email && <><dt>Email</dt><dd>{who.email}</dd></>}
        {who.phone && <><dt>Phone</dt><dd className="num">{who.phone}</dd></>}
      </dl>
      {who.edits ? (
        <>
          <p className="help">You can change your phone and mailing address yourself. The club changes your name and email for you. <AskTheClub treasurerEmail={treasurerEmail} /></p>
          <div className="box-foot"><a className="btn btn-line" href="/family/details">Update my details</a></div>
        </>
      ) : <p className="help">For now, the club makes changes for you. <AskTheClub treasurerEmail={treasurerEmail} /></p>}
    </section>
  );
}

/** Shown in place of the family's boxes when the roster has nothing the portal may show for this family, whatever the reason. */
export function NotSetUpBox({ treasurerEmail }: { treasurerEmail: string | null }) {
  return (
    <section className="box" aria-labelledby="setup-h">
      <h2 id="setup-h">Your family isn&apos;t set up here yet</h2>
      <p className="help">The club hasn&apos;t finished setting up your family in the portal. There&apos;s nothing you need to do. Please check back
        soon{treasurerEmail ? <>, or email the treasurer at <a href={`mailto:${treasurerEmail}`}>{treasurerEmail}</a></> : null}.</p>
    </section>
  );
}

/** Where the students and details come from, and when they were last read. Nothing when that isn't known. */
export function RosterAsOf({ family }: { family: MyFamily }) {
  if (!family.rosterReadAt) return null;
  return <p className="roster-asof">From the club&apos;s QuickBooks, as of <LocalTime iso={family.rosterReadAt} />.</p>;
}
