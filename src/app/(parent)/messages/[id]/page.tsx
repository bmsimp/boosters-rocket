import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { openMyMessage } from "@/lib/messages/parent";
import { Card, LocalTime, PageHeader } from "@/app/components/ui";
import { ParentVersionView, PostedBy } from "../message-parts";

export const metadata = { title: "Message" };
export const dynamic = "force-dynamic";

/**
 * One message (spec section 5): its current version in full, its pictures in place and its files listed, who posted
 * it and when, and once edited, "Edited <date>" with Earlier versions, each opening to that version in full. Who edited
 * is not said: only the poster can. The id in the address is untrusted: anything that isn't a message, or is a deleted
 * one, is "not found". Opening it marks it read for this parent alone (openMyMessage()), as the page is drawn.
 */
export default async function MessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireParentPage(`/messages/${id}`);
  const m = await openMyMessage(ctx.parentId, id);
  if (!m) notFound();
  const [current, ...earlier] = m.versions;
  return (
    <main className="wrap single">
      <PageHeader title={current!.title} back={{ href: "/messages", label: "Back to Messages" }}
        lede={<><PostedBy row={m} />{m.editedAt && <> · Edited <LocalTime iso={m.editedAt.toISOString()} dateOnly /></>}</>} />
      <Card>
        <ParentVersionView version={current!} filesLabel="Files" />
      </Card>
      {earlier.length > 0 && (
        <Card title="Earlier versions" titleId="earlier-h" description="What this message said before it was edited.">
          {earlier.map((v) => (
            <details key={v.n} className="more">
              <summary>Version {v.n} · <LocalTime iso={v.savedAt.toISOString()} dateOnly /></summary>
              <div className="stack">
                <h3 className="message-title">{v.title}</h3>
                <ParentVersionView version={v} filesLabel={`Files of version ${v.n}`} />
              </div>
            </details>
          ))}
        </Card>
      )}
    </main>
  );
}
