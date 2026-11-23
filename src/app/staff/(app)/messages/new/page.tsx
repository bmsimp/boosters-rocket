import { requireStaffPage } from "@/lib/guards";
import { familiesReached } from "@/lib/messages/staff";
import { emailReach } from "@/lib/messages/mail";
import { Card, PageHeader } from "@/app/components/ui";
import { MessageForm } from "../message-form";

export const metadata = { title: "New message" };
export const dynamic = "force-dynamic";

/** A new message to every family: its title, its body in the rich editor, its pictures and files, and Post. */
export default async function NewMessagePage() {
  await requireStaffPage("Messages.Post.ReadWrite");
  const [families, emailTo] = await Promise.all([familiesReached(), emailReach()]);
  return (
    <main className="wrap single">
      <PageHeader title="New message" back={{ href: "/staff/messages", label: "Back to Messages" }}
        lede="It goes to every family in the club, who read it in the portal. You can edit it later; families can still read each earlier version." />
      <Card>
        <MessageForm families={families} emailTo={emailTo} />
      </Card>
    </main>
  );
}
