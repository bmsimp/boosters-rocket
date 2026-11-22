import type { MyContact, MyStudent } from "@/lib/parents/my-family";
import { Card } from "../components/ui/card";
import { KeyValue } from "../components/ui/key-value";
import { LinkButton } from "../components/ui/button";
import { List, ListRow } from "../components/ui/list";

/**
 * The boxes Home and Family share. Server components: every name, address and number here is the portal's own record
 * (a name or phone the take-in brought from QuickBooks among them) or the person's own, written as text only.
 */

/** The family's students, a row each by name (the Family page). Home lists them with where each stands: home-parts.tsx. */
export function StudentsBox({ students }: { students: MyStudent[] }) {
  return (
    <Card className="students-box" title="Your students" titleId="stu-h">
      <List>
        {students.length > 0
          ? students.map((s) => <ListRow key={String(s.id)} title={s.name} />)
          : <ListRow title="The club has no active students listed for your family right now." />}
      </List>
    </Card>
  );
}

/** Who to ask about a change, mid-sentence: the treasurer at their address when the club has set one, otherwise the club. */
export function AskTheClub({ treasurerEmail }: { treasurerEmail: string | null }) {
  return treasurerEmail
    ? <>ask the treasurer at <a href={`mailto:${treasurerEmail}`}>{treasurerEmail}</a></>
    : <>ask the club</>;
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
          ? <>{who.edits === "family" ? "You can change your family's phone and mailing address, and your sign-in email" : "You can change your phone, mailing address and sign-in email"} {ownEmail === "below" ? "below" : "on your Family page"}. To change your name, <AskTheClub treasurerEmail={treasurerEmail} />.</>
          : <>You can change {who.edits === "family" ? "your family's" : "your"} phone and mailing address. To change your name or email, <AskTheClub treasurerEmail={treasurerEmail} />.</>}</p>
      ) : <p className="help">For now, <AskTheClub treasurerEmail={treasurerEmail} /> to make any changes.</p>}
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
