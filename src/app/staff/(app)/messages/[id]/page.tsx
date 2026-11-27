import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { staffMessage } from "@/lib/messages/staff";
import { mailResults, mailWords } from "@/lib/messages/mail";
import { can } from "@/lib/permissions/effective";
import { Card, DataTable, LinkButton, LocalTime, Notice, PageHeader } from "@/app/components/ui";
import { VersionView } from "../message-view";
import { DeleteMessage } from "../delete-message";

export const metadata = { title: "Message" };
export const dynamic = "force-dynamic";

/**
 * One message as families see it (spec section 4): the current version, who posted it and when, and each earlier
 * version by its date, and its mail results: delivered, failed and waiting per emailed version, with the failed
 * addresses (staff only: they are other families' addresses). Edit is for its poster alone, Delete for those who may
 * delete (an Admin), behind its confirm step. Not audited: a message is the same for every family, and the failed
 * addresses are a list across families, like the roster's.
 */
export default async function StaffMessagePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
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
  // ?version=N reads an earlier version, found among this message's own; anything else reads the current one.
  const asked = ((await searchParams) ?? {}).version;
  const shown = earlier.find((v) => typeof asked === "string" && String(v.n) === asked) ?? null;
  const isPoster = m.postedBy.id === ctx.staffUserId;
  const mail = await mailResults(m.id);
  const mayDelete = can(ctx.effective, "Messages.Delete.ReadWrite");
  return (
    <main className="wrap single">
      <PageHeader title={current!.title} back={back}
        lede={<>Posted by {m.postedBy.name} · <LocalTime iso={m.postedAt.toISOString()} dateOnly />{earlier.length > 0 && <> · Edited <LocalTime iso={current!.savedAt.toISOString()} dateOnly /></>}</>}
        actions={isPoster ? <LinkButton variant="outlined" href={`/staff/messages/${m.id}/edit`}>Edit</LinkButton> : undefined} />
      {shown ? (
        <Card title={`Version ${shown.n}`} titleId="version-h" description={<>Saved <LocalTime iso={shown.savedAt.toISOString()} dateOnly />, before it was edited. <a className="link-line" href={`/staff/messages/${m.id}`}>Read the current version</a></>}>
          <h3 className="message-title">{shown.title}</h3>
          <VersionView version={shown} filesLabel={`Files of version ${shown.n}`} />
        </Card>
      ) : (
        <Card>
          <VersionView version={current!} filesLabel="Files" />
          {!isPoster && <p className="hint">Only {m.postedBy.name}, who posted it, can edit it.</p>}
        </Card>
      )}
      {earlier.length > 0 && (
        <Card title="Earlier versions" titleId="earlier-h" description="Families can open each of these too.">
          <ul className="version-list">
            {earlier.map((v) => (
              <li key={v.id}>{shown?.n === v.n
                ? <span aria-current="page">Version {v.n} · <LocalTime iso={v.savedAt.toISOString()} dateOnly /> (shown)</span>
                : <a className="link-line" href={`/staff/messages/${m.id}?version=${v.n}`}>Version {v.n} · <LocalTime iso={v.savedAt.toISOString()} dateOnly /></a>}</li>
            ))}
          </ul>
        </Card>
      )}
      {mail.length > 0 && (
        <Card title="Email" titleId="mail-h" description="Only staff see who it went to. Each address is tried up to three times.">
          {mail.map((v) => (
            <div key={v.versionId} className="stack">
              <h3>Version {v.n}: {mailWords(v)}</h3>
              {v.failures.length > 0 && (
                <DataTable caption={`Addresses version ${v.n} couldn't be delivered to`} rows={v.failures} rowKey={(f) => f.address} columns={[
                  { key: "address", header: "Address", rowHeader: true, cell: (f) => f.address },
                  { key: "reason", header: "Why", cell: (f) => f.reason },
                ]} />
              )}
            </div>
          ))}
        </Card>
      )}
      {mayDelete && (
        <Card title="Delete" titleId="delete-h" description="For a message that must disappear, say one that held the wrong family's details.">
          <DeleteMessage messageId={m.id} />
        </Card>
      )}
    </main>
  );
}
