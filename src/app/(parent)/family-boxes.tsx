import type { MyContact, MyStudent } from "@/lib/parents/my-family";
import type { MySeason } from "@/lib/seasons/my-season";
import { Card } from "../components/ui/card";
import { KeyValue } from "../components/ui/key-value";
import { LinkButton } from "../components/ui/button";
import { DoneCount, RequirementLines, SeasonFoot, StepState, asksAnything, currentStep } from "./season-parts";

/**
 * The boxes Home and Family share. Server components: every name, address and number here is the portal's own record
 * (a name or phone the take-in brought from QuickBooks among them) or the person's own, written as text only.
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
    <Card className="students-box" title="Your students" titleId="stu-h" description={season && step ? <>{season.name} · {step.name}</> : undefined}>
      {students.length > 0 ? (
        <ul className="students">
          {students.map((s) => {
            const mine = step ? standing.get(String(s.id)) : undefined;
            return (
              <li key={String(s.id)}>
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
    </Card>
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
    <Card className="students-box" title={season.name} titleId="step-h" description={step ? step.name : undefined}>
      <SeasonFoot season={season} />
    </Card>
  );
}

/** How to reach the club about a change: the treasurer's address when the club has set one. */
function AskTheClub({ treasurerEmail }: { treasurerEmail: string | null }) {
  return treasurerEmail
    ? <>Email the treasurer at <a href={`mailto:${treasurerEmail}`}>{treasurerEmail}</a> and they&apos;ll update it.</>
    : <>Ask the club and they&apos;ll update it.</>;
}

/**
 * The person's name and sign-in email with the phone the portal holds (their own, or their family's in books with no
 * parent type), from the portal's own records (loadMyFamily()'s `me`). `who.edits` gets the way to the page where the
 * phone and address are changed; the link carries no id, because that page takes whose they are from the session.
 * `ownEmail`: the person may change their sign-in email themselves (canChangeMyEmail), and the words say where: in the
 * box below (Family, which offers it) or on the Family page (Home). The new address is the one they then sign in with,
 * and the club's records are brought up to date with it.
 */
export function DetailsBox({ who, treasurerEmail, ownEmail = false }: { who: MyContact; treasurerEmail: string | null; ownEmail?: false | "below" | "family" }) {
  return (
    <Card className="details-box" title="Your details" titleId="det-h" description="How the club reaches you"
      actions={who.edits && <LinkButton plain variant="secondary" href="/family/details">Update my details</LinkButton>}>
      <KeyValue items={[
        { key: "name", label: "Name", value: who.name },
        who.email ? { key: "email", label: "Email", value: who.email } : null,
        // In books with no parent type the phone is the family's, shared by its parents: said so beside the person's own name and email.
        who.phone ? { key: "phone", label: who.edits === "family" ? "Family phone" : "Phone", value: who.phone, numeric: true } : null,
      ]} />
      {who.edits ? (
        <p className="help">{ownEmail
          ? <>You can change {who.edits === "family" ? "your family's" : "your"} phone and mailing address yourself, and your sign-in email {ownEmail === "below" ? "below" : "on your Family page"}. The club changes your name for you. <AskTheClub treasurerEmail={treasurerEmail} /></>
          : <>You can change {who.edits === "family" ? "your family's" : "your"} phone and mailing address yourself. The club changes your name and email for you. <AskTheClub treasurerEmail={treasurerEmail} /></>}</p>
      ) : <p className="help">For now, the club makes changes for you. <AskTheClub treasurerEmail={treasurerEmail} /></p>}
    </Card>
  );
}

/** Shown in place of the family's boxes when the roster has nothing the portal may show for this family, whatever the reason. */
export function NotSetUpBox({ treasurerEmail }: { treasurerEmail: string | null }) {
  return (
    <Card title={<>Your family isn&apos;t set up here yet</>} titleId="setup-h">
      <p className="help">The club hasn&apos;t finished setting up your family in the portal. There&apos;s nothing you need to do. Please check back
        soon{treasurerEmail ? <>, or email the treasurer at <a href={`mailto:${treasurerEmail}`}>{treasurerEmail}</a></> : null}.</p>
    </Card>
  );
}
