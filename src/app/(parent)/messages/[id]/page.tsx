import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { openMyMessage } from "@/lib/messages/parent";
import { Card, LocalTime, PageHeader } from "@/app/components/ui";
import { ParentVersionView, PostedBy } from "../message-parts";

export const metadata = { title: "Message" };
export const dynamic = "force-dynamic";

/**
 * One message (spec section 5): its current version in full, its pictures in place and its files listed, who posted
 * it and when, and once edited, "Edited <date>" with Earlier versions, a list of links each to that version in full (`?version=N`, found
 * among this message's own versions; anything else reads the current one). Who edited
 * is not said: only the poster can. The id in the address is untrusted: anything that isn't a message, or is a deleted
 * one, is "not found". Opening it marks it read for this parent alone (openMyMessage()), as the page is drawn.
 */
export default async function MessagePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const ctx = await requireParentPage(`/messages/${id}`);
  const m = await openMyMessage(ctx.parentId, id);
  if (!m) notFound();
  const [current, ...earlier] = m.versions;
  // ?version=N reads an earlier version of this message, found among its own; anything else reads the current one.
  const asked = ((await searchParams) ?? {}).version;
  const shown = earlier.find((v) => typeof asked === "string" && String(v.n) === asked) ?? null;
  return (
    <main className="wrap single">
      <PageHeader title={current!.title} back={{ href: "/messages", label: "Back to Messages" }}
        lede={<><PostedBy row={m} />{m.editedAt && <> · Edited <LocalTime iso={m.editedAt.toISOString()} dateOnly /></>}</>} />
      {shown ? (
        <Card title={`Version ${shown.n}`} titleId="version-h" description={<>Saved <LocalTime iso={shown.savedAt.toISOString()} dateOnly />, before it was edited. <a className="link-line" href={`/messages/${id}`}>Read the current version</a></>}>
          <h3 className="message-title">{shown.title}</h3>
          <ParentVersionView version={shown} filesLabel={`Files of version ${shown.n}`} />
        </Card>
      ) : (
        <Card>
          <ParentVersionView version={current!} filesLabel="Files" />
        </Card>
      )}
      {earlier.length > 0 && (
        <Card title="Earlier versions" titleId="earlier-h" description="What this message said before it was edited.">
          <ul className="version-list">
            {earlier.map((v) => (
              <li key={v.n}>{shown?.n === v.n
                ? <span aria-current="page">Version {v.n} · <LocalTime iso={v.savedAt.toISOString()} dateOnly /> (shown)</span>
                : <a className="link-line" href={`/messages/${id}?version=${v.n}`}>Version {v.n} · <LocalTime iso={v.savedAt.toISOString()} dateOnly /></a>}</li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
