import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { listMessages } from "@/lib/messages/staff";
import { Card, DataTable, EmptyState, LinkButton, LocalTime, PageHeader } from "@/app/components/ui";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

/**
 * Every message staff have posted to families, newest first (spec section 4): its title, who posted it and when, and
 * whether it was edited or deleted. A deleted message keeps its row with who deleted it, and nothing of its content.
 * Not audited: it shows no one family's data.
 */
export default async function MessagesPage() {
  await requireStaffPage("Messages.Post.ReadWrite");
  const rows = await listMessages();
  const newButton = <LinkButton href="/staff/messages/new">New message</LinkButton>;
  return (
    <main className="wrap single">
      <PageHeader title="Messages" lede="News for every family in the club. Parents read it in the portal." actions={rows.length ? newButton : undefined} />
      <Card>
        {rows.length === 0
          ? <EmptyState title="No messages yet" action={newButton}>Messages you post here go to every family, who read them in the portal.</EmptyState>
          : (
            <DataTable caption="Messages, the newest first" captionHidden rows={rows} rowKey={(r) => r.id} columns={[
              { key: "title", header: "Message", rowHeader: true, cell: (r) => (r.deleted ? <span className="hint">Deleted message</span> : <Link href={`/staff/messages/${r.id}`}>{r.title}</Link>) },
              { key: "poster", header: "Posted by", cell: (r) => r.poster },
              { key: "posted", header: "Posted", sorted: "descending", cell: (r) => <LocalTime iso={r.postedAt.toISOString()} dateOnly /> },
              { key: "state", header: "Changes", cell: (r) => (r.deleted
                ? <>Deleted by {r.deleted.by ?? "an Admin"} on <LocalTime iso={r.deleted.at.toISOString()} dateOnly /></>
                : r.editedAt ? <>Edited <LocalTime iso={r.editedAt.toISOString()} dateOnly /></> : "None") },
            ]} />
          )}
      </Card>
    </main>
  );
}
