import { requireParentPage } from "@/lib/guards";
import { loadMyContact } from "@/lib/parents/contact-edits";
import { canChangeMyEmail } from "@/lib/parents/email-change";
import { getClubSettings } from "@/lib/settings/club";
import { NotSetUpBox } from "../../family-boxes";
import { DetailsEditor } from "./details-form";
import { Card, KeyValue, LinkButton, PageHeader } from "../../../components/ui";

export const metadata = { title: "Update your details" };

/**
 * Where a parent changes their phone and mailing address (v1 spec §6.2): their own, or, in books with no parent type,
 * their family's, which every parent in the family shares (stage 3's slice 11a). Whose they are comes from the session
 * and nothing else: the address of this page has no id in it, and neither has the form. The details are the portal's
 * own, so every parent the gate lets in gets the form; only a family the portal may not show gets the not-set-up box.
 */
export default async function FamilyDetailsPage() {
  const ctx = await requireParentPage("/family/details");
  const [view, club, ownEmail] = await Promise.all([loadMyContact(ctx), getClubSettings(), canChangeMyEmail(ctx)]);
  const lede = view.state === "none" ? undefined : view.me.edits === "family"
    ? <>These are the details the club uses to reach your family. Every parent in your family shares them, so a change here changes them for all of you.</>
    : <>These are the details the club uses to reach you.</>;
  return (
    <main className="wrap single family-page">
      <PageHeader title="Update your details" lede={lede} />
      {view.state === "none" ? (
        <NotSetUpBox treasurerEmail={club.treasurerEmail} />
      ) : (
        <>
          {/* No id in the link: the page takes whose address it is from the session. */}
          <Card title="You" titleId="who-h" actions={ownEmail && <LinkButton variant="secondary" href="/family/email">Change my sign-in email</LinkButton>}>
            <KeyValue items={[{ key: "name", label: "Name", value: view.me.name }, { key: "email", label: "Email", value: view.me.email }]} />
            {ownEmail ? (
              <p className="help">You can change the email you sign in with yourself. The club changes names. {club.treasurerEmail
                ? <>Email the treasurer at <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a> and they&apos;ll update yours.</>
                : <>Ask the club and they&apos;ll update yours.</>}</p>
            ) : (
              <p className="help">The club changes names and email addresses. {club.treasurerEmail
                ? <>Email the treasurer at <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a> and they&apos;ll update them.</>
                : <>Ask the club and they&apos;ll update them.</>}</p>
            )}
          </Card>
          <Card title={view.me.edits === "family" ? "Your family's phone and mailing address" : "Phone and mailing address"} titleId="edit-h"
            description={<>How the club reaches {view.me.edits === "family" ? "your family" : "you"}</>}>
            {/* It is sent the values and their version only. */}
            <DetailsEditor initial={view.form} />
          </Card>
        </>
      )}
    </main>
  );
}
