import { requireStaffPage } from "@/lib/guards";
import { mailSummary } from "@/lib/mail/settings";
import { MailGuide } from "@/app/components/mail-settings/mail-guide";
import { saveMailSettingsAction, sendTestMailAction } from "../actions";

export const metadata = { title: "Set up outgoing mail" };
export const dynamic = "force-dynamic";

/** The mail steps, the same guided task as setup's step: what is done in words, then each step in order. */
export default async function MailSetupPage() {
  await requireStaffPage("Settings.Mail.ReadWrite");
  const summary = await mailSummary();
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/mail">Back to mail settings</a></p>
      <h1 className="page-title">Set up outgoing mail</h1>
      <p className="lede">Parents sign in with a code the portal emails them, so the portal has to be able to send mail. Do these steps in order: mail works when the test email arrives.</p>
      <MailGuide summary={summary} save={saveMailSettingsAction} test={sendTestMailAction} />
    </main>
  );
}
