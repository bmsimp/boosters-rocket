import { notFound, redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { familiesReached, staffMessage } from "@/lib/messages/staff";
import { emailReach } from "@/lib/messages/mail";
import { Card, PageHeader } from "@/app/components/ui";
import { MessageForm } from "../../message-form";

export const metadata = { title: "Edit message" };
export const dynamic = "force-dynamic";

/**
 * An edit of a message, opened on its current version (spec section 4): for its poster alone, whatever anyone else's
 * permissions; someone else is refused as any guard refuses, with an `access.refused` row. Saving adds a version.
 */
export default async function EditMessagePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Messages.Post.ReadWrite");
  const { id } = await params;
  const m = await staffMessage(id);
  if (!m || m.deleted) notFound();
  if (m.postedBy.id !== ctx.staffUserId) {
    await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "access.refused", permission: "Messages.Post.ReadWrite",
      targetType: "message", targetId: m.id, after: { reason: "not_poster" }, ip: ctx.ip });
    redirect("/refused");
  }
  const current = m.versions[0]!;
  const [families, emailTo] = await Promise.all([familiesReached(), emailReach()]);
  return (
    <main className="wrap single">
      <PageHeader title="Edit message" back={{ href: `/staff/messages/${m.id}`, label: "Back to the message" }}
        lede="Saving adds a new version. Families see it, marked Edited, and can still open the earlier ones." />
      <Card>
        <MessageForm families={families} emailTo={emailTo} edit={{ messageId: m.id, title: current.title, body: current.body, files: current.files }} />
      </Card>
    </main>
  );
}
