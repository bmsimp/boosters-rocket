import { renderBody } from "@/lib/messages/body";
import { fileSizeWords, MESSAGE_FILE_WORDS } from "@/lib/messages/file-types";
import type { StaffVersion } from "@/lib/messages/staff";
import { LinkButton, List, ListRow } from "@/app/components/ui";
import { staffFileHref } from "./paths";

/**
 * One version of a message as families see it: its body, its pictures in place, and its files listed by their names
 * with their sizes, each opened through the staff file route. Every piece of staff text is drawn as text.
 */
export function VersionView({ version, filesLabel }: { version: StaffVersion; filesLabel: string }) {
  const listed = version.files;
  return (
    <div className="message-view stack">
      {renderBody(version.body, { fileHref: staffFileHref })}
      {listed.length > 0 && (
        <List label={filesLabel}>
          {listed.map((f) => (
            <ListRow key={f.id} title={f.name} meta={[f.picture ? "Picture" : MESSAGE_FILE_WORDS[f.type], fileSizeWords(f.size)]}
              action={<LinkButton plain size="sm" variant="tonal" href={staffFileHref(f.id)}>{f.picture ? "Open" : "Download"}<span className="visually-hidden"> {f.name}</span></LinkButton>} />
          ))}
        </List>
      )}
    </div>
  );
}
