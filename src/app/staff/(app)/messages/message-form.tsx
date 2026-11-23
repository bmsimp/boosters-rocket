"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionOutcome } from "@/app/components/notice";
import { Button, Checkbox, Field, List, ListRow, TextInput } from "@/app/components/ui";
import { RichTextEditor, type RichTextHandle } from "@/app/components/rich-text-editor";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { checkBody, hasContent, NO_BODY, type MessageBody } from "@/lib/messages/body";
import { fileSizeWords, MESSAGE_FILE_MAX_BYTES, MESSAGE_FILE_WORDS, MESSAGE_FILES_MAX, type MessageFileType } from "@/lib/messages/file-types";
import { editMessageAction, postMessageAction, removeHeldFileAction } from "./actions";
import { STAFF_UPLOAD_HREF, staffFileHref, staffFileIdOf } from "./paths";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };
/** A file the form lists: `held` while it is this form's upload, not yet saved in a version. */
export type FormFile = { id: string; name: string; type: MessageFileType; size: number; picture: boolean; held?: boolean };

const PICTURE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
/** A file sent as a picture that is kept as an attachment instead: said as done, not as a refusal. */
class KeptAsFile extends Error {}
const FILE_ACCEPT = `${PICTURE_ACCEPT},application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx`;

/**
 * Sends one file's bytes to the staff upload route, which answers as an action does: the file kept, or why not. An
 * answer that isn't that shape (a proxy's error page, say) throws, and safely() turns it into the usual sentence.
 */
async function uploadTo(href: string, file: File): Promise<{ ok: true; message: string; file: Omit<FormFile, "held"> } | { ok: false; errors: string[] }> {
  const res = await fetch(href, { method: "POST", body: file, credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/octet-stream" } });
  const r: unknown = await res.json();
  if (typeof r !== "object" || r === null || !("ok" in r)) throw new Error("not an answer");
  return r as { ok: true; message: string; file: Omit<FormFile, "held"> } | { ok: false; errors: string[] };
}

/**
 * The form for a new message or an edit (spec section 4): a title, the body in the rich editor with its pictures, the
 * files attached, and Post or Save. The editor is what staff see: there is no preview. Each file is uploaded as it is
 * added and held until the save. A body with no words and no picture is refused here before it is sent, as the
 * server refuses it (NO_BODY). Given only what it shows: for an edit, the message's id and its current version's
 * title, body and files; and, only while the club allows messages to be emailed, how many addresses it would go to
 * (`emailTo`), said beside its box, ticked: "Also email families" for a post, "Email families about this change" for
 * an edit.
 */
export function MessageForm({ families, emailTo, edit }: {
  families: number;
  emailTo: number | null;
  edit?: { messageId: string; title: string; body: MessageBody; files: FormFile[] };
}) {
  const router = useRouter();
  const [title, setTitle] = useState(edit?.title ?? "");
  const [files, setFiles] = useState<FormFile[]>(edit?.files ?? []);
  const [outcome, setOutcome] = useState<Done | null>(null);
  const [saving, startSaving] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [email, setEmail] = useState(emailTo !== null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<RichTextHandle>(null);

  const say = (d: Done) => { setOutcome(d); requestAnimationFrame(() => outcomeRef.current?.focus()); };

  /** Sends one file, checking the form's own limits first: the file kept, or the sentences saying why not. */
  async function send(file: File): Promise<FormFile | string[]> {
    if (files.length >= MESSAGE_FILES_MAX) return [`A message can hold at most ${MESSAGE_FILES_MAX} files, its pictures included. Remove one to add another.`];
    if (file.size > MESSAGE_FILE_MAX_BYTES) return [`${file.name.slice(0, 200)} is over 10 MB. Make it smaller, or share it another way.`];
    const q = new URLSearchParams({ name: file.name });
    if (edit) q.set("message", edit.messageId);
    const r = await safely(() => uploadTo(`${STAFF_UPLOAD_HREF}?${q}`, file), failed);
    if (!r.ok) return r.errors;
    const added: FormFile = { ...r.file, held: true };
    setFiles((fs) => [...fs, added]);
    return added;
  }

  async function upload(file: File): Promise<FormFile | null> {
    const r = await send(file);
    if (Array.isArray(r)) { say({ ok: false, errors: r }); return null; }
    return r;
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    setOutcome(null);
    for (const f of [...list]) if (!(await upload(f))) break;
    setUploading(false);
  }

  /**
   * A picture from the editor's upload box: uploaded with the other files, its id given back to be shown in the body.
   * A refusal is thrown in the form's words, which the editor hands to onPictureError; so is a file that turned out not
   * to be a picture, which is kept as an attachment.
   */
  async function uploadPicture(file: File): Promise<string> {
    setUploading(true);
    setOutcome(null);
    try {
      const r = await send(file);
      if (Array.isArray(r)) throw new Error(r.join(" "));
      if (!r.picture) throw new KeptAsFile(`${r.name} isn't a picture, so it is attached below instead of shown in the message.`);
      return r.id;
    } finally {
      setUploading(false);
    }
  }
  const onPictureError = (e: Error) => say(e instanceof KeptAsFile ? { ok: true, message: e.message } : { ok: false, errors: [e.message] });

  async function remove(f: FormFile) {
    if (f.held) {
      const r = await safely(() => removeHeldFileAction(f.id), failed);
      if (!r.ok) { say(r); return; }
    }
    setFiles((fs) => fs.filter((x) => x.id !== f.id));
    if (f.picture) bodyRef.current?.removePicture(f.id);
  }

  function save() {
    const editor = bodyRef.current;
    if (!editor || saving || uploading) return;
    const body = editor.getJSON();
    // The server's check, asked first so an empty message is answered without a round trip; the server asks it again.
    const checked = checkBody(body, new Set(files.filter((f) => f.picture).map((f) => f.id)));
    if (checked.ok && !hasContent(checked.body)) { say({ ok: false, errors: [NO_BODY] }); return; }
    const draft = { title, body, files: files.map((f) => f.id), email: emailTo !== null && email };
    startSaving(async () => {
      if (edit) {
        const r = await safely(() => editMessageAction(edit.messageId, draft), failed);
        if (r.ok) router.push(`/staff/messages/${edit.messageId}`); else say(r);
      } else {
        const r = await safely(() => postMessageAction(draft), failed);
        if (r.ok) router.push(`/staff/messages/${r.id}`); else say(r);
      }
    });
  }

  const goesTo = emailTo === null ? "" : `Goes to ${emailTo} ${emailTo === 1 ? "address" : "addresses"}. `;
  return (
    <form className="stack message-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <TextInput id="msg-title" label="Title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} hint="Up to 120 characters." />
      <RichTextEditor ref={bodyRef} id="msg-body" label="Message" hint="Some words or a picture. Headings, bold, italic, underline, lists, links and pictures (select one to describe it)."
        initial={edit?.body ?? null}
        pictures={{ fileHref: staffFileHref, idOf: staffFileIdOf, upload: uploadPicture, onError: onPictureError, accept: PICTURE_ACCEPT }} />
      <Field id="msg-files" label="Files" hint={`PDF, Word, Excel, PowerPoint or pictures, up to 10 MB each and ${MESSAGE_FILES_MAX} in all, pictures in the message included.`}>
        {(aria) => <input type="file" multiple accept={FILE_ACCEPT} className="file-input" disabled={uploading} {...aria}
          onChange={async (e) => { const input = e.currentTarget; await addFiles(input.files); input.value = ""; }} />}
      </Field>
      {files.length > 0 && (
        <List label="Files in this message">
          {files.map((f) => (
            <ListRow key={f.id} title={f.name} meta={[f.picture ? "Picture" : MESSAGE_FILE_WORDS[f.type], fileSizeWords(f.size)]}
              action={<Button size="sm" variant="quiet" onClick={() => void remove(f)}>Remove<span className="visually-hidden"> {f.name}</span></Button>} />
          ))}
        </List>
      )}
      {emailTo !== null && (
        <Checkbox id="msg-email" label={edit ? "Email families about this change" : "Also email families"} checked={email} onChange={(e) => setEmail(e.target.checked)}
          hint={edit ? `${goesTo}The email says the message was updated, and families see it as new again. Untick it for a small fix.`
            : `${goesTo}Each parent gets it once at the address they sign in with. Files and pictures stay in the portal; the email links to it.`} />
      )}

      {outcome && <ActionOutcome state={outcome} ref={outcomeRef} />}
      <div className="row-actions">
        <Button type="submit" busy={saving} aria-disabled={uploading || undefined}>{edit ? "Save changes" : "Post"}</Button>
      </div>
      {!edit && <p className="hint">{`This goes to ${families} ${families === 1 ? "family" : "families"}.`}</p>}
    </form>
  );
}
