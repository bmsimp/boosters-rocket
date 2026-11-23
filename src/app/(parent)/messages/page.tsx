import { requireParentPage } from "@/lib/guards";
import { myMessages } from "@/lib/messages/parent";
import { Card, EmptyState, PageHeader } from "@/app/components/ui";
import { MessageList } from "./message-parts";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

/**
 * Every message the club has posted, newest first (spec section 5), with "New" on those this parent hasn't opened:
 * read and new are this parent's own (ctx.parentId), never their family's or another guardian's. No tab: Home's card
 * and quiet line lead here.
 */
export default async function MessagesPage() {
  const ctx = await requireParentPage("/messages");
  const rows = await myMessages(ctx.parentId);
  return (
    <main className="wrap single">
      <PageHeader title="Messages" lede="News from the club, for every family." back={{ href: "/", label: "Back to Home" }} />
      <Card>
        {rows.length === 0
          ? <EmptyState title="No messages yet">When the club posts news for families, you&apos;ll read it here.</EmptyState>
          : <MessageList rows={rows} label="Messages, the newest first" />}
      </Card>
    </main>
  );
}
