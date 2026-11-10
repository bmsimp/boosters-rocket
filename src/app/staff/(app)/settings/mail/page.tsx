import { requireStaffPage } from "@/lib/guards";
import { mailSummary } from "@/lib/mail/settings";
import { MailSettingsCard } from "@/app/components/mail-settings/mail-card";
import { MailHelp } from "@/app/components/mail-settings/mail-steps";
import { MailWarning } from "../../mail-warning";
import { saveMailSettingsAction, sendTestMailAction } from "./actions";

export const metadata = { title: "Mail settings" };

export default async function MailSettingsPage() {
  await requireStaffPage("Settings.Mail.ReadWrite");
  const summary = await mailSummary();
  return (
    <main className="wrap single">
      <h1 className="page-title">Mail</h1>
      <p className="lede">How the portal sends sign-in codes and welcome emails. Only Admins can change this, because whoever controls outgoing mail can read parents&apos; sign-in codes.</p>
      <MailWarning canFix />
      <section className="box" aria-labelledby="mail-h"><h2 id="mail-h">Outgoing mail</h2>
        <MailSettingsCard summary={summary} save={saveMailSettingsAction} test={sendTestMailAction} />
        <MailHelp tenant="<tenant>" />
      </section>
    </main>
  );
}
