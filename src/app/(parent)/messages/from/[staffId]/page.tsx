import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { staffProfile } from "@/lib/messages/parent";
import { Card, PageHeader } from "@/app/components/ui";
import { MessageList } from "../../message-parts";

export const metadata = { title: "From the club" };
export const dynamic = "force-dynamic";

/**
 * A staff member who posts messages (spec section 5): their name, the address they show families as a mailto link,
 * and the messages they posted. Only for someone with a message that isn't deleted: any other id, a staff member's
 * who never posted included, is "not found", so the club's staff can't be listed from here.
 */
export default async function StaffProfilePage({ params }: { params: Promise<{ staffId: string }> }) {
  const { staffId } = await params;
  const ctx = await requireParentPage(`/messages/from/${staffId}`);
  const p = await staffProfile(ctx.parentId, staffId);
  if (!p) notFound();
  return (
    <main className="wrap single">
      <PageHeader title={p.name} back={{ href: "/messages", label: "Back to Messages" }}
        lede={<>Email <a href={`mailto:${p.email}`}>{p.email}</a></>} />
      <Card title={`Messages from ${p.name}`} titleId="from-h">
        <MessageList rows={p.messages} label={`Messages from ${p.name}, the newest first`} />
      </Card>
    </main>
  );
}
