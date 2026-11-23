import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { messagesEmailAllowed } from "@/lib/settings/messages";
import { Card, StateWords } from "@/app/components/ui";
import { SettingsHeader } from "../back-to-settings";
import { SwitchButton } from "../parents/forms";
import { setMessagesEmailAction } from "./actions";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

/**
 * The club's one setting for messages (club messages, spec section 4): whether a message may be emailed to families.
 * Seen with the Club's read; changed by an Admin alone (Settings.Messages.ReadWrite), and shown to anyone else
 * read-only with the line that says who can.
 */
export default async function MessagesSettingsPage() {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const on = await messagesEmailAllowed();
  const canChange = can(ctx.effective, "Settings.Messages.ReadWrite");
  return (
    <main className="wrap single">
      <SettingsHeader effective={ctx.effective} title="Messages" lede="Staff who may post write messages to every family, which parents read in the portal. The club decides whether they can also be emailed." />
      <Card title="Emailing messages to families" titleId="msg-email-h">
        <StateWords state={on ? "done" : "todo"} words={on ? "On: messages can be emailed to families" : "Off: messages are only in the portal"} />
        <p>{on
          ? "When someone posts a message or edits one, \"Also email families\" is offered, ticked. Each parent who can sign in is emailed once, at their sign-in address."
          : "Parents read messages in the portal only. Nothing is emailed, whatever is chosen when a message is posted."}</p>
        {canChange
          ? <SwitchButton quiet={on} label={on ? "Stop emailing messages" : "Allow messages to be emailed to families"} pendingLabel="Saving…" act={setMessagesEmailAction.bind(null, !on)} />
          : <p className="hint">Only an Admin can change this.</p>}
      </Card>
    </main>
  );
}
