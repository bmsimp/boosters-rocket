import type { MyContact, MyFamily, MyStudent } from "@/lib/parents/my-family";
import type { MySeason } from "@/lib/seasons/my-season";
import { LocalTime } from "../components/local-time";
import { DoneCount, RequirementLines, SeasonFoot, StepState, asksAnything, currentStep } from "./season-parts";

/**
 * The boxes Home and Family share. Server components: every name, address and number here is QuickBooks text or the
 * person's own, written as text only.
 */

/**
 * The family's students. With `season` (Home), each student also shows where they stand in the current step: the state
 * in words, then each requirement asked of them. What the family itself is asked comes after the students.
 */
export function StudentsBox({ students, season = null }: { students: MyStudent[]; season?: MySeason | null }) {
  const step = currentStep(season);
  // Matched by the student's own record, never by name (two students may share one) nor by a QuickBooks id.
  const standing = new Map((step?.students ?? []).map((s) => [String(s.id), s]));
  return (
    <section className="box students-box" aria-labelledby="stu-h">
      <h2 id="stu-h">Your students</h2>
      {season && step && <p>{season.name} · {step.name}</p>}
      {students.length > 0 ? (
        <ul className="students">
          {students.map((s, i) => {
            const mine = step && s.id !== null ? standing.get(String(s.id)) : undefined;
            return (
              <li key={s.id === null ? `no-record-${i}` : String(s.id)}>
                <span className="who"><b>{s.name}</b></span>
                {mine && step && (
                  <>
                    <DoneCount lines={mine.lines} />
                    <StepState lines={mine.lines} stepName={step.name} />
                    {mine.lines.length > 0 && <RequirementLines lines={mine.lines} today={season!.today} />}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : <p>The club has no active students listed for your family right now.</p>}
      {season && <SeasonFoot season={season} />}
    </section>
  );
}

/**
 * For a club that doesn't list students: what the current step asks of the family itself, in the students box's place.
 * Nothing when the step asks nothing of it and nothing is left behind.
 */
export function FamilyStepBox({ season }: { season: MySeason }) {
  const step = currentStep(season);
  if (!(step && step.family.length > 0) && season.leftBefore === 0 && (step || !asksAnything(season))) return null;
  return (
    <section className="box students-box" aria-labelledby="step-h">
      <h2 id="step-h">{season.name}</h2>
      {step && <p>{step.name}</p>}
      <SeasonFoot season={season} />
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
 * `ownEmail`: the person may change their sign-in email themselves (canChangeMyEmail), and the words say where: in the
 * box below (Family, which offers it) or on the Family page (Home).
 */
export function DetailsBox({ who, treasurerEmail, ownEmail = false }: { who: MyContact; treasurerEmail: string | null; ownEmail?: false | "below" | "family" }) {
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
          <p className="help">{ownEmail
            ? <>You can change your phone and mailing address yourself, and your sign-in email {ownEmail === "below" ? "below" : "on your Family page"}. The club changes your name for you. <AskTheClub treasurerEmail={treasurerEmail} /></>
            : <>You can change your phone and mailing address yourself. The club changes your name and email for you. <AskTheClub treasurerEmail={treasurerEmail} /></>}</p>
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
