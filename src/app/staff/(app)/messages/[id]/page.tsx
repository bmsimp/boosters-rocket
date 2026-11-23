import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { staffMessage } from "@/lib/messages/staff";
import { Card, LinkButton, LocalTime, Notice, PageHeader } from "@/app/components/ui";
import { VersionView } from "../message-view";

export const metadata = { title: "Message" };
export const dynamic = "force-dynamic";

/**
 * One message as families see it (spec section 4): the current version, who posted it and when, and each earlier
 * version by its date. Edit is for its poster alone. Not audited: a message is the same for every family.
 */
export default async function StaffMessagePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Messages.Post.ReadWrite");
  const { id } = await params;
  const m = await staffMessage(id);
  if (!m) notFound();
  const back = { href: "/staff/messages", label: "Back to Messages" };
  if (m.deleted) {
    return (
      <main className="wrap single">
        <PageHeader title="Deleted message" back={back} />
        <Notice tone="info">Deleted by {m.deleted.by ?? "an Admin"} on <LocalTime iso={m.deleted.at.toISOString()} dateOnly />. Its content can&apos;t be brought back.</Notice>
      </main>
    );
  }
  const [current, ...earlier] = m.versions;
  const isPoster = m.postedBy.id === ctx.staffUserId;
  return (
    <main className="wrap single">
      <PageHeader title={current!.title} back={back}
        lede={<>Posted by {m.postedBy.name} · <LocalTime iso={m.postedAt.toISOString()} dateOnly />{earlier.length > 0 && <> · Edited <LocalTime iso={current!.savedAt.toISOString()} dateOnly /></>}</>}
        actions={isPoster ? <LinkButton variant="secondary" href={`/staff/messages/${m.id}/edit`}>Edit</LinkButton> : undefined} />
      <Card>
        <VersionView version={current!} filesLabel="Files" />
        {!isPoster && <p className="hint">Only {m.postedBy.name}, who posted it, can edit it.</p>}
      </Card>
      {earlier.length > 0 && (
        <Card title="Earlier versions" titleId="earlier-h" description="Families can open each of these too.">
          {earlier.map((v) => (
            <details key={v.id} className="more">
              <summary>Version {v.n} · <LocalTime iso={v.savedAt.toISOString()} dateOnly /></summary>
              <div className="stack">
                <h3 className="message-title">{v.title}</h3>
                <VersionView version={v} filesLabel={`Files of version ${v.n}`} />
              </div>
            </details>
          ))}
        </Card>
      )}
    </main>
  );
}
