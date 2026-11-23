"use client";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { Button, Field, List, ListRow, TextInput } from "@/app/components/ui";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { checkBody, renderBody, safeHref, ALT_MAX, type MessageBody } from "@/lib/messages/body";
import { fileSizeWords, MESSAGE_FILE_WORDS, MESSAGE_FILES_MAX, type MessageFileType } from "@/lib/messages/file-types";
import { editMessageAction, postMessageAction, removeHeldFileAction, uploadMessageFileAction } from "./actions";
import { staffFileHref } from "./paths";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };
/** A file the form lists: `held` while it is this form's upload, not yet saved in a version. */
export type FormFile = { id: string; name: string; type: MessageFileType; size: number; picture: boolean; held?: boolean };

const PICTURE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";
const FILE_ACCEPT = `${PICTURE_ACCEPT},application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx`;

/**
 * A picture in the body: the id of a file uploaded to this message and its words for someone who can't see it, never
 * an address (spec section 6). The editor draws it from the staff file route; a pasted `<img>` with no id is dropped.
 */
const Picture = Image.extend({
  addAttributes() {
    return {
      attachment: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment"),
        renderHTML: (a: Record<string, unknown>) => (typeof a.attachment === "string" ? { "data-attachment": a.attachment, src: staffFileHref(a.attachment) } : {}),
      },
      alt: { default: null },
    };
  },
  parseHTML() { return [{ tag: "img[data-attachment]" }]; },
});

/** What the editor offers, and nothing else: StarterKit without code, quotes, rules or strike-through, headings at two levels. */
const EXTENSIONS = [
  StarterKit.configure({
    blockquote: false, code: false, codeBlock: false, horizontalRule: false, strike: false,
    heading: { levels: [2, 3] },
    link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri: (url: string) => safeHref(url) !== null, HTMLAttributes: { rel: "noopener noreferrer", target: null } },
  }),
  Picture.configure({ inline: false, allowBase64: false }),
];

/**
 * The form for a new message or an edit (spec section 4): a title, the body in the rich editor with its pictures, the
 * files attached, Preview (the message as a parent will see it, with how many families it goes to), and Post or Save.
 * Each file is uploaded as it is added and held until the save. Given only what it shows: for an edit, the message's
 * id and its current version's title, body and files.
 */
export function MessageForm({ families, edit }: {
  families: number;
  edit?: { messageId: string; title: string; body: MessageBody; files: FormFile[] };
}) {
  const router = useRouter();
  const [title, setTitle] = useState(edit?.title ?? "");
  const [files, setFiles] = useState<FormFile[]>(edit?.files ?? []);
  const [preview, setPreview] = useState<{ title: string; body: ReturnType<typeof checkBody> } | null>(null);
  const [outcome, setOutcome] = useState<Done | null>(null);
  const [panel, setPanel] = useState<"link" | "picture" | null>(null);
  const [saving, startSaving] = useTransition();
  const [uploading, setUploading] = useState(false);
  const outcomeRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: (edit?.body ?? null) as JSONContent | null,
    immediatelyRender: false,
    editorProps: { attributes: { class: "editor-area", role: "textbox", "aria-multiline": "true", "aria-labelledby": "msg-body-label", "aria-describedby": "msg-body-hint" } },
  });

  const pictureIds = () => new Set(files.filter((f) => f.picture).map((f) => f.id));
  const say = (d: Done) => { setOutcome(d); requestAnimationFrame(() => outcomeRef.current?.focus()); };

  async function upload(file: File): Promise<FormFile | null> {
    if (files.length >= MESSAGE_FILES_MAX) { say({ ok: false, errors: [`A message can hold at most ${MESSAGE_FILES_MAX} files, its pictures included. Remove one to add another.`] }); return null; }
    const form = new FormData();
    form.set("file", file);
    form.set("message", edit?.messageId ?? "");
    for (const f of files) form.append("listed", f.id);
    const r = await safely(() => uploadMessageFileAction(form), failed);
    if (!r.ok) { say(r); return null; }
    const added: FormFile = { ...r.file, held: true };
    setFiles((fs) => [...fs, added]);
    return added;
  }

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    setOutcome(null);
    for (const f of [...list]) if (!(await upload(f))) break;
    setUploading(false);
  }

  async function remove(f: FormFile) {
    if (f.held) {
      const r = await safely(() => removeHeldFileAction(f.id), failed);
      if (!r.ok) { say(r); return; }
    }
    setFiles((fs) => fs.filter((x) => x.id !== f.id));
    if (f.picture && editor) dropPicture(editor, f.id);
  }

  function showPreview() {
    if (!editor) return;
    setPreview({ title: title.trim(), body: checkBody(editor.getJSON(), pictureIds()) });
  }

  function save() {
    if (!editor || saving || uploading) return;
    const draft = { title, body: editor.getJSON(), files: files.map((f) => f.id) };
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

  const reach = `This goes to ${families} ${families === 1 ? "family" : "families"}.`;
  return (
    <form className="stack message-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div hidden={preview !== null} className="stack">
        <TextInput id="msg-title" label="Title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} hint="Up to 120 characters." />
        <div className="field">
          <span className="field-label" id="msg-body-label">Message</span>
          <p className="field-hint" id="msg-body-hint">Headings, bold, italic, underline, lists, links and pictures.</p>
          <Toolbar editor={editor} panel={panel} setPanel={setPanel} />
          {panel === "link" && editor && <LinkPanel editor={editor} close={() => setPanel(null)} />}
          {panel === "picture" && editor && (
            <PicturePanel busy={uploading} close={() => setPanel(null)} add={async (file, alt) => {
              setUploading(true);
              setOutcome(null);
              const added = await upload(file);
              setUploading(false);
              if (!added) return false;
              if (!added.picture) { say({ ok: true, message: `${added.name} isn't a picture, so it is attached below instead of shown in the message.` }); return true; }
              editor.chain().focus().insertContent({ type: "image", attrs: { attachment: added.id, alt: alt.trim() || null } }).run();
              return true;
            }} />
          )}
          <EditorContent editor={editor} className="editor" />
        </div>
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
      </div>

      {preview && (
        <section className="message-preview stack" aria-labelledby="msg-preview-h">
          <Notice tone="info" title="Preview" titleId="msg-preview-h" level={2}>{reach} This is how families will see it.</Notice>
          {!preview.title && <Notice tone="problem">Give the message a title before posting it.</Notice>}
          {preview.body.ok
            ? <article className="message-view"><h3 className="message-title">{preview.title || "Untitled"}</h3>{renderBody(preview.body.body, { fileHref: staffFileHref })}<PreviewFiles files={files} /></article>
            : <Notice tone="problem">{preview.body.error}</Notice>}
        </section>
      )}

      {outcome && <ActionOutcome state={outcome} ref={outcomeRef} />}
      <div className="row-actions">
        <Button type="submit" busy={saving} aria-disabled={uploading || undefined}>{edit ? "Save changes" : "Post"}</Button>
        {preview
          ? <Button variant="secondary" onClick={() => setPreview(null)}>Back to editing</Button>
          : <Button variant="secondary" onClick={showPreview}>Preview</Button>}
      </div>
      {!edit && <p className="hint">{reach}</p>}
    </form>
  );
}

function PreviewFiles({ files }: { files: FormFile[] }): ReactNode {
  if (!files.length) return null;
  return (
    <List label="Files">
      {files.map((f) => <ListRow key={f.id} title={f.name} meta={[f.picture ? "Picture" : MESSAGE_FILE_WORDS[f.type], fileSizeWords(f.size)]} />)}
    </List>
  );
}

/** Takes every copy of a picture out of the body, when its file is removed. */
function dropPicture(editor: Editor, id: string) {
  const at: { pos: number; size: number }[] = [];
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "image" && node.attrs.attachment === id) at.push({ pos, size: node.nodeSize }); });
  if (!at.length) return;
  const tr = editor.state.tr;
  for (const { pos, size } of at.reverse()) tr.delete(pos, pos + size);
  editor.view.dispatch(tr);
}

/** The formatting buttons, each saying whether it is on where the cursor is. */
function Toolbar({ editor, panel, setPanel }: { editor: Editor | null; panel: string | null; setPanel: (p: "link" | "picture" | null) => void }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e?.isActive("heading", { level: 2 }) ?? false, h3: e?.isActive("heading", { level: 3 }) ?? false,
      bold: e?.isActive("bold") ?? false, italic: e?.isActive("italic") ?? false, underline: e?.isActive("underline") ?? false,
      bullets: e?.isActive("bulletList") ?? false, numbers: e?.isActive("orderedList") ?? false, link: e?.isActive("link") ?? false,
    }),
  }) ?? { h2: false, h3: false, bold: false, italic: false, underline: false, bullets: false, numbers: false, link: false };
  const run = (f: (e: Editor) => void) => () => { if (editor) f(editor); };
  const tool = (label: string, pressed: boolean, act: () => void) => (
    <Button size="sm" variant="quiet" aria-pressed={pressed} onClick={act} aria-disabled={!editor || undefined}>{label}</Button>
  );
  return (
    <div className="editor-tools" role="group" aria-label="Formatting">
      {tool("Heading", on.h2, run((e) => e.chain().focus().toggleHeading({ level: 2 }).run()))}
      {tool("Subheading", on.h3, run((e) => e.chain().focus().toggleHeading({ level: 3 }).run()))}
      {tool("Bold", on.bold, run((e) => e.chain().focus().toggleBold().run()))}
      {tool("Italic", on.italic, run((e) => e.chain().focus().toggleItalic().run()))}
      {tool("Underline", on.underline, run((e) => e.chain().focus().toggleUnderline().run()))}
      {tool("Bulleted list", on.bullets, run((e) => e.chain().focus().toggleBulletList().run()))}
      {tool("Numbered list", on.numbers, run((e) => e.chain().focus().toggleOrderedList().run()))}
      {tool("Link", on.link || panel === "link", () => setPanel(panel === "link" ? null : "link"))}
      {tool("Add picture", panel === "picture", () => setPanel(panel === "picture" ? null : "picture"))}
    </div>
  );
}

/** The address of a link: on the selected words, or inserted as its own words when nothing is selected. */
function LinkPanel({ editor, close }: { editor: Editor; close: () => void }) {
  const current = editor.getAttributes("link").href as string | undefined;
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const href = safeHref(value.includes(":") ? value : `https://${value}`);
    if (!href) { setError("Enter a full address, such as https://club.org/schedule or mailto:coach@club.org."); return; }
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !current) chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    else chain.extendMarkRange("link").setLink({ href }).run();
    close();
  };
  return (
    <div className="editor-panel stack">
      <TextInput id="msg-link" label="Link address" type="url" inputMode="url" value={value} error={error ?? undefined} maxLength={2000}
        onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        hint="It links the words you selected, or is added as its own words." />
      <div className="row-actions">
        <Button size="sm" variant="secondary" onClick={add}>{current ? "Change link" : "Add link"}</Button>
        {current && <Button size="sm" variant="quiet" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); close(); }}>Remove link</Button>}
        <Button size="sm" variant="quiet" onClick={close}>Cancel</Button>
      </div>
    </div>
  );
}

/** A picture for the body, with its words for someone who can't see it, uploaded when Add is pressed. */
function PicturePanel({ busy, add, close }: { busy: boolean; add: (file: File, alt: string) => Promise<boolean>; close: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  return (
    <div className="editor-panel stack">
      <Field id="msg-picture" label="Picture" hint="JPEG, PNG, GIF or WebP, up to 10 MB.">
        {(aria) => <input type="file" accept={PICTURE_ACCEPT} className="file-input" {...aria} onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />}
      </Field>
      <TextInput id="msg-picture-alt" label="What the picture shows" maxLength={ALT_MAX} value={alt} onChange={(e) => setAlt(e.target.value)}
        hint="For families who use a screen reader, or whose picture doesn't load." />
      <div className="row-actions">
        <Button size="sm" variant="secondary" busy={busy} onClick={async () => { if (file && !busy && (await add(file, alt))) close(); }}>Add picture</Button>
        <Button size="sm" variant="quiet" onClick={close}>Cancel</Button>
      </div>
    </div>
  );
}
