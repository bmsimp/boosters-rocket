import { requireParentPage } from "@/lib/guards";
import { canChangeMyEmail } from "@/lib/parents/email-change";
import { hasAuthenticator } from "@/lib/parents/authenticator";
import { hasPasskey } from "@/lib/parents/passkeys";
import { howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { getParentSettings } from "@/lib/parents/settings";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { Card, KeyValue, LinkButton, PageHeader } from "../../components/ui";
import { DetailsBox, NotSetUpBox, StudentsBox } from "../family-boxes";

export const metadata = { title: "Family" };

/**
 * Family: the family's name, its students (a List), the parent's own details, the families they can switch between,
 * and their account with the way to their sign-in settings. Each region is a Card; nothing is a card inside a card.
 */
export default async function FamilyPage() {
  const ctx = await requireParentPage("/family");
  const [family, club, ownEmail, app, passkey, settings] = await Promise.all([loadMyFamily(ctx), getClubSettings(), canChangeMyEmail(ctx), hasAuthenticator(ctx.parentId),
    hasPasskey(ctx.parentId), getParentSettings()]);
  return (
    <main className="wrap single family-page">
      <PageHeader title={family ? family.name : "Your family"} />
      {family ? (
        <>
          {family.students && <StudentsBox students={family.students} />}
          <DetailsBox who={family.me} treasurerEmail={club.treasurerEmail} ownEmail={ownEmail && "below"} />
        </>
      ) : <NotSetUpBox treasurerEmail={club.treasurerEmail} />}
      {ctx.families.length > 1 && (
        // Only the family being viewed is named here; the chooser lists the others.
        <Card title="Your families" titleId="fams-h" actions={<LinkButton plain variant="secondary" href="/choose-family">Switch family</LinkButton>}>
          <p>You&apos;re a guardian in {ctx.families.length} families.{family ? <> You&apos;re looking at {family.name} now.</> : null}</p>
        </Card>
      )}
      {/* No id in either link: each page takes whose sign-in it is from the session. */}
      <Card title="Your account" titleId="acct-h" description="How you sign in to the portal"
        actions={<>
          <LinkButton variant="secondary" href="/family/sign-in">Sign-in settings</LinkButton>
          {ownEmail && <LinkButton variant="secondary" href="/family/email">Change my sign-in email</LinkButton>}
        </>}>
        {/* What Your details already shows isn't said twice: with the family shown, its name always and its email when it has one. */}
        {!(family && family.me.email) && (
          <KeyValue items={[!family && { key: "name", label: "Name", value: ctx.name }, { key: "email", label: "Email", value: ctx.email }]} />
        )}
        {/* How they sign in: their passkey (since SI-7b), on a new device the code from their authenticator app (since SI-6b), or the code we email; at Strict, every time (SI-10b). */}
        <p className="help">{howYouSignIn({ app, passkey, strict: settings.level === "strict" }).how}</p>
      </Card>
    </main>
  );
}
