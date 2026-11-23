"use client";
import { useImperativeHandle, useMemo, useState, type Ref } from "react";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Button, Field, TextInput } from "@/app/components/ui";
import { ALT_MAX, safeHref } from "@/lib/messages/body";
import { EditorToolbar, ToolbarGroup, ToolButton } from "./toolbar";

/*
 * The rich text editor: Tiptap, with the toolbar and look of Tiptap's Simple Editor template (MIT, Copyright (c) 2025
 * Tiptap; ./LICENSE), kept to what a checked body holds (src/lib/messages/body.ts, checkBody()'s allowlist): headings
 * at two levels, bold, italic, underline, bulleted and numbered lists, links, line breaks and pictures, with undo and
 * redo. The template's other tools (quotes, code, highlight, alignment, task lists, sub- and superscript, rules) are
 * left out, since checkBody() would refuse what they make. Its menus, popovers and tooltips are not brought in: with
 * two heading levels and two kinds of list each is a button of its own, a link's and a picture's fields open in a
 * panel under the toolbar, and a button's name shows on hover. Drawn by booster.css's "Rich text editor" block.
 * Whatever it sends is checked again on the server: it offers the allowlist, it doesn't enforce it.
 */

/** What the form holding an editor asks of it: the document to save, and taking a picture out when its file is removed. */
export type RichTextHandle = { getJSON: () => JSONContent; removePicture: (attachment: string) => void };

/**
 * Pictures in the body, for a form whose files are uploaded as they are added: where one is drawn from (`fileHref`, a
 * file's id), and `add`, which uploads a picture with its words for someone who can't see it and answers with the id
 * of the file to show (`{ insert }`), or that the panel may close with nothing to show (`{ close: true }`: the form
 * kept the file as an attachment), or null when it was refused (the form says why), leaving the panel open.
 */
export type RichTextPictures = {
  fileHref: (id: string) => string;
  add: (file: File, alt: string) => Promise<{ insert: string } | { close: true } | null>;
  busy: boolean;
  /** The picture types the file field offers, and its hint. */
  accept: string;
  hint: string;
};

/**
 * A picture in the body: the id of a file uploaded to the form and its words for someone who can't see it, never an
 * address (body.ts). It is drawn from `fileHref`; a pasted `<img>` with no id is dropped.
 */
const pictureNode = (fileHref: ((id: string) => string) | undefined) => Image.extend({
  addAttributes() {
    return {
      attachment: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment"),
        renderHTML: (a: Record<string, unknown>) => (typeof a.attachment === "string"
          ? { "data-attachment": a.attachment, ...(fileHref ? { src: fileHref(a.attachment) } : {}) } : {}),
      },
      alt: { default: null },
    };
  },
  parseHTML() { return [{ tag: "img[data-attachment]" }]; },
}).configure({ inline: false, allowBase64: false });

/** What the editor offers, and nothing else: StarterKit without code, quotes, rules or strike-through, headings at two levels. */
const extensionsFor = (fileHref: ((id: string) => string) | undefined) => [
  StarterKit.configure({
    blockquote: false, code: false, codeBlock: false, horizontalRule: false, strike: false,
    heading: { levels: [2, 3] },
    link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri: (url: string) => safeHref(url) !== null, HTMLAttributes: { rel: "noopener noreferrer", target: null } },
  }),
  pictureNode(fileHref),
];

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** Takes every copy of a picture out of the body. */
function dropPicture(editor: Editor, id: string) {
  const at: { pos: number; size: number }[] = [];
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "image" && node.attrs.attachment === id) at.push({ pos, size: node.nodeSize }); });
  if (!at.length) return;
  const tr = editor.state.tr;
  for (const { pos, size } of at.reverse()) tr.delete(pos, pos + size);
  editor.view.dispatch(tr);
}

/**
 * A labelled rich text field: its label and hint over a frame holding the toolbar and the writing area, which is a
 * multi-line textbox named by the label. `initial` is the document it opens on; the form reads what was written
 * through `ref` (RichTextHandle). Without `pictures` it offers no picture button.
 */
export function RichTextEditor({ id, label, hint, initial, pictures, ref }: {
  id: string; label: string; hint?: string; initial?: JSONContent | null; pictures?: RichTextPictures; ref?: Ref<RichTextHandle>;
}) {
  const [panel, setPanel] = useState<"link" | "picture" | null>(null);
  const fileHref = pictures?.fileHref;
  // The schema is made once: a new set of extensions would make a new editor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const extensions = useMemo(() => extensionsFor(fileHref), []);
  const editor = useEditor({
    extensions,
    content: initial ?? null,
    immediatelyRender: false,
    editorProps: { attributes: { class: "rte-area", role: "textbox", "aria-multiline": "true", "aria-labelledby": `${id}-label`, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) } },
  });

  useImperativeHandle(ref, () => ({
    getJSON: () => editor?.getJSON() ?? EMPTY_DOC,
    removePicture: (attachment) => { if (editor) dropPicture(editor, attachment); },
  }), [editor]);

  const close = () => { setPanel(null); editor?.commands.focus(); };
  const toggle = (p: "link" | "picture") => (panel === p ? close() : setPanel(p));

  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>{label}</span>
      {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}
      <div className="rte">
        <Tools editor={editor} panel={panel} toggle={toggle} id={id} pictures={pictures !== undefined} />
        {panel === "link" && editor && <LinkPanel id={`${id}-link`} editor={editor} close={close} />}
        {panel === "picture" && editor && pictures && (
          <PicturePanel id={`${id}-picture`} pictures={pictures} close={close} insert={(attachment, alt) => {
            editor.chain().focus().insertContent({ type: "image", attrs: { attachment, alt: alt.trim() || null } }).run();
          }} />
        )}
        <EditorContent editor={editor} className="rte-content" />
      </div>
    </div>
  );
}

/** The toolbar: undo and redo; the two headings; the two lists; bold, italic and underline; a link and a picture. */
function Tools({ editor, panel, toggle, id, pictures }: {
  editor: Editor | null; panel: string | null; toggle: (p: "link" | "picture") => void; id: string; pictures: boolean;
}) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      undo: e?.can().undo() ?? false, redo: e?.can().redo() ?? false,
      h2: e?.isActive("heading", { level: 2 }) ?? false, h3: e?.isActive("heading", { level: 3 }) ?? false,
      bullets: e?.isActive("bulletList") ?? false, numbers: e?.isActive("orderedList") ?? false,
      bold: e?.isActive("bold") ?? false, italic: e?.isActive("italic") ?? false, underline: e?.isActive("underline") ?? false,
      link: e?.isActive("link") ?? false,
    }),
  }) ?? { undo: false, redo: false, h2: false, h3: false, bullets: false, numbers: false, bold: false, italic: false, underline: false, link: false };
  const run = (f: (e: Editor) => void) => () => { if (editor) f(editor); };
  const none = !editor;
  return (
    <EditorToolbar label="Formatting">
      <ToolbarGroup>
        <ToolButton icon="undo" label="Undo" unavailable={none || !on.undo} onPress={run((e) => e.chain().focus().undo().run())} />
        <ToolButton icon="redo" label="Redo" unavailable={none || !on.redo} onPress={run((e) => e.chain().focus().redo().run())} />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolButton icon="heading2" label="Heading" pressed={on.h2} unavailable={none} onPress={run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())} />
        <ToolButton icon="heading3" label="Subheading" pressed={on.h3} unavailable={none} onPress={run((e) => e.chain().focus().toggleHeading({ level: 3 }).run())} />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolButton icon="bulletList" label="Bulleted list" pressed={on.bullets} unavailable={none} onPress={run((e) => e.chain().focus().toggleBulletList().run())} />
        <ToolButton icon="orderedList" label="Numbered list" pressed={on.numbers} unavailable={none} onPress={run((e) => e.chain().focus().toggleOrderedList().run())} />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolButton icon="bold" label="Bold" pressed={on.bold} unavailable={none} onPress={run((e) => e.chain().focus().toggleBold().run())} />
        <ToolButton icon="italic" label="Italic" pressed={on.italic} unavailable={none} onPress={run((e) => e.chain().focus().toggleItalic().run())} />
        <ToolButton icon="underline" label="Underline" pressed={on.underline} unavailable={none} onPress={run((e) => e.chain().focus().toggleUnderline().run())} />
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolButton icon="link" label="Link" active={on.link} expanded={panel === "link"} controls={panel === "link" ? `${id}-link` : undefined} unavailable={none} onPress={() => toggle("link")} />
        {pictures && <ToolButton icon="picture" label="Picture" expanded={panel === "picture"} controls={panel === "picture" ? `${id}-picture` : undefined} unavailable={none} onPress={() => toggle("picture")} />}
      </ToolbarGroup>
    </EditorToolbar>
  );
}

/** The address of a link: on the selected words, or inserted as its own words when nothing is selected. Escape closes it. */
function LinkPanel({ id, editor, close }: { id: string; editor: Editor; close: () => void }) {
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
    <div id={id} className="rte-panel stack" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}>
      <TextInput id={`${id}-address`} label="Link address" type="url" inputMode="url" value={value} error={error ?? undefined} maxLength={2000} autoFocus
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

/** A picture for the body, with its words for someone who can't see it, uploaded when Add is pressed. Escape closes it. */
function PicturePanel({ id, pictures, insert, close }: { id: string; pictures: RichTextPictures; insert: (attachment: string, alt: string) => void; close: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const add = async () => {
    if (!file || pictures.busy) return;
    const r = await pictures.add(file, alt);
    if (!r) return;
    if ("insert" in r) insert(r.insert, alt);
    close();
  };
  return (
    <div id={id} className="rte-panel stack" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}>
      <Field id={`${id}-file`} label="Picture" hint={pictures.hint}>
        {(aria) => <input type="file" accept={pictures.accept} className="file-input" autoFocus {...aria} onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />}
      </Field>
      <TextInput id={`${id}-alt`} label="What the picture shows" maxLength={ALT_MAX} value={alt} onChange={(e) => setAlt(e.target.value)}
        hint="For families who use a screen reader, or whose picture doesn't load." />
      <div className="row-actions">
        <Button size="sm" variant="secondary" busy={pictures.busy} onClick={() => void add()}>Add picture</Button>
        <Button size="sm" variant="quiet" onClick={close}>Cancel</Button>
      </div>
    </div>
  );
}
