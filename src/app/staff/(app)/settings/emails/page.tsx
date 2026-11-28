import { requireStaffPage } from "@/lib/guards";
import { emailStandings, type EmailStanding } from "@/lib/mail/template-store";
import { EMAIL_GROUPS, EMAILS } from "@/lib/email-templates/catalog";
import { Card, List, ListRow, StatusDot } from "@/app/components/ui";
import { SettingsHeader } from "../back-to-settings";

export const metadata = { title: "Emails" };
export const dynamic = "force-dynamic";

const STANDING: Record<EmailStanding, { tone: "done" | "due" | "neutral"; words: string }> = {
  club: { tone: "done", words: "Club's words" },
  default: { tone: "neutral", words: "Default" },
  needs_look: { tone: "due", words: "Needs a look" },
};

/**
 * Every email the portal sends to families, by what it is about (email templates, spec section 6): each row opens the
 * email, with whether it goes in the club's words or the default. Seen with the Club's read; the words are changed on
 * each email's page by those with Settings.Emails.ReadWrite. Not audited: no family's data.
 */
export default async function EmailsPage() {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const standings = await emailStandings();
  return (
    <main className="wrap single">
      <SettingsHeader effective={ctx.effective} title="Emails" lede="The words of each email the portal sends. Links, codes and the safety lines are always added by the portal." />
      {EMAIL_GROUPS.map((g, i) => (
        <Card key={g} title={g} titleId={`emails-g${i}`}>
          <List label={g}>
            {EMAILS.filter((e) => e.group === g).map((e) => {
              const s = STANDING[standings[e.key] ?? "default"];
              return <ListRow key={e.key} href={`/staff/settings/emails/${e.key}`} title={e.title} meta={e.sentWhen} trail={<StatusDot tone={s.tone} words={s.words} />} />;
            })}
          </List>
        </Card>
      ))}
    </main>
  );
}
