import Link from "next/link";
import { renderBody } from "@/lib/messages/body";
import { fileSizeWords, MESSAGE_FILE_WORDS } from "@/lib/messages/file-types";
import type { ParentMessageRow, ParentVersion } from "@/lib/messages/parent";
import { Card, LinkButton, List, ListRow, LocalTime } from "@/app/components/ui";

/** Where a parent fetches a message's picture or file: the parent file route (./files/[id]/route.ts). */
export const parentFileHref = (id: string): string => `/messages/files/${id}`;

/** "Posted by <name> · <date>", the name linking to the poster's profile. */
export function PostedBy({ row }: { row: Pick<ParentMessageRow, "poster" | "postedAt"> }) {
  return <>Posted by <Link href={`/messages/from/${row.poster.id}`}>{row.poster.name}</Link> · <LocalTime iso={row.postedAt.toISOString()} dateOnly /></>;
}

/**
 * Messages, newest first: each its title (a link to it), "New" with its icon for one this parent hasn't opened, who
 * posted it and when, and "Edited" when it has more than one version. The poster's name is plain text here: the whole
 * row is the link to the message, and the poster's profile is on the message's page.
 */
export function MessageList({ rows, label }: { rows: ParentMessageRow[]; label: string }) {
  return (
    <List label={label}>
      {rows.map((r) => (
        <ListRow key={r.id} href={`/messages/${r.id}`} title={r.title} status={r.isNew ? { tone: "info", words: "New" } : undefined}
          meta={[<>Posted by {r.poster.name}</>, <LocalTime key="d" iso={r.postedAt.toISOString()} dateOnly />, r.editedAt && "Edited"]} />
      ))}
    </List>
  );
}

/** One version of a message: its body, its pictures in place, and its files by their names and sizes, each to download. */
export function ParentVersionView({ version, filesLabel }: { version: ParentVersion; filesLabel: string }) {
  return (
    <div className="message-view stack">
      {renderBody(version.body, { fileHref: parentFileHref })}
      {version.files.length > 0 && (
        <List label={filesLabel}>
          {version.files.map((f) => (
            <ListRow key={f.id} title={f.name} meta={[f.picture ? "Picture" : MESSAGE_FILE_WORDS[f.type], fileSizeWords(f.size)]}
              action={<LinkButton plain size="sm" variant="tonal" href={parentFileHref(f.id)}>{f.picture ? "Open" : "Download"}<span className="visually-hidden"> {f.name}</span></LinkButton>} />
          ))}
        </List>
      )}
    </div>
  );
}

/**
 * Home's messages (spec section 5): while this parent has new ones, a card at the top saying how many, with the newest
 * one's title and the way to Messages; once all are read, a quiet line to Messages; with no messages at all, nothing.
 */
export function HomeMessages({ summary }: { summary: { total: number; fresh: number; newest: { id: string; title: string } | null } }) {
  if (summary.total === 0) return null;
  if (summary.fresh === 0 || !summary.newest) return <p className="home-messages"><Link className="link-line" href="/messages">Messages</Link></p>;
  const heading = summary.fresh === 1 ? "1 new message from the club" : `${summary.fresh} new messages from the club`;
  return (
    <Card className="home-messages" title={heading} titleId="home-messages-h"
      actions={<LinkButton variant="outlined" href="/messages">{summary.fresh === 1 ? "Read it in Messages" : "Read them in Messages"}</LinkButton>}>
      <p><Link href={`/messages/${summary.newest.id}`}>{summary.newest.title}</Link></p>
    </Card>
  );
}
