"use client";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { EditorContent, EditorContext, useEditor, type JSONContent } from "@tiptap/react";

// --- Tiptap Core Extensions (the template's, less those whose nodes or marks body.ts refuses) ---
import { StarterKit } from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { Typography } from "@tiptap/extension-typography";
import { Selection } from "@tiptap/extensions";

// --- The template's UI, unchanged (src/app/components/tiptap/, README.md there) ---
import { Button } from "@/app/components/tiptap/tiptap-ui-primitive/button";
import { Toolbar, ToolbarGroup, ToolbarSeparator } from "@/app/components/tiptap/tiptap-ui-primitive/toolbar";
import { ImageUploadNode, type UploadFunction } from "@/app/components/tiptap/tiptap-node/image-upload-node/image-upload-node-extension";
import { HeadingDropdownMenu } from "@/app/components/tiptap/tiptap-ui/heading-dropdown-menu";
import { ImageUploadButton } from "@/app/components/tiptap/tiptap-ui/image-upload-button";
import { ListDropdownMenu } from "@/app/components/tiptap/tiptap-ui/list-dropdown-menu";
import { LinkPopover, LinkContent, LinkButton } from "@/app/components/tiptap/tiptap-ui/link-popover";
import { MarkButton } from "@/app/components/tiptap/tiptap-ui/mark-button";
import { UndoRedoButton } from "@/app/components/tiptap/tiptap-ui/undo-redo-button";
import { ArrowLeftIcon } from "@/app/components/tiptap/tiptap-icons/arrow-left-icon";
import { LinkIcon } from "@/app/components/tiptap/tiptap-icons/link-icon";
import { useIsBreakpoint } from "@/app/components/tiptap/hooks/use-is-breakpoint";

// --- The template's node styles, as simple-editor.tsx imports them; then ours, which brings in its global styles too ---
import "@/app/components/tiptap/tiptap-node/list-node/list-node.scss";
import "@/app/components/tiptap/tiptap-node/image-node/image-node.scss";
import "@/app/components/tiptap/tiptap-node/heading-node/heading-node.scss";
import "@/app/components/tiptap/tiptap-node/paragraph-node/paragraph-node.scss";
import "./rich-text-editor.scss";

import { safeHref } from "@/lib/messages/body";
import { PictureDescription } from "./picture-description";
import { UploadedAlt, uploadedName } from "./uploaded-alt";

/*
 * The rich text editor: a thin copy of the Simple Editor template's simple-editor.tsx (Tiptap's MIT template, kept
 * unchanged in src/app/components/tiptap/), with what is ours in this folder alone: the toolbar keeps only the tools
 * whose nodes and marks body.ts keeps (undo and redo, headings at levels 2 and 3, bulleted and numbered lists, bold,
 * italic, underline, a link, and a picture where the form takes them), the picture upload goes to the form's own
 * route, a selected picture gets a field for its description (picture-description.tsx), and rich-text-editor.scss
 * maps the template's look onto the portal's tokens. The template's quote, code, highlight, alignment, task list, sub-
 * and superscript, rule, search and theme tools are left out, since checkBody() would refuse what they make; whatever
 * the editor sends is checked again on the server.
 */

/** What the form holding an editor asks of it: the body to save (toBody()), and taking a picture out when its file is removed. */
export type RichTextHandle = { getJSON: () => JSONContent; removePicture: (attachment: string) => void };

/**
 * Pictures in the body, for a form whose files are uploaded as they are added: where a picture's file is fetched from
 * (`fileHref`) and back (`idOf`), and `upload`, which sends the file and answers with its id, or throws an Error whose
 * message is the sentence to show (the form shows it through `onError`, as the template's upload node reports).
 */
export type RichTextPictures = {
  fileHref: (id: string) => string;
  idOf: (href: string) => string | null;
  upload: (file: File) => Promise<string>;
  onError: (error: Error) => void;
  /** The picture types the upload offers. */
  accept: string;
};

/**
 * The extensions: the template's list, less those body.ts refuses. A picture is the template's standard Image (its
 * `src` and `alt`) while it is in the editor; toBody() turns it into body.ts's `{ attachment, alt }`.
 * tests/unit/rich-text-editor.test.ts holds the schema to body.ts.
 */
export const extensionsFor = (o: { upload?: UploadFunction; onError?: (error: Error) => void; accept?: string; uploaded?: Map<string, string> }) => [
  StarterKit.configure({
    blockquote: false, code: false, codeBlock: false, horizontalRule: false, strike: false,
    heading: { levels: [2, 3] },
    link: {
      openOnClick: false, enableClickSelection: true, autolink: true, defaultProtocol: "https",
      isAllowedUri: (url: string) => safeHref(url) !== null, HTMLAttributes: { rel: "noopener noreferrer", target: null },
    },
  }),
  Image.configure({ inline: false, allowBase64: false }),
  Typography,
  Selection,
  // The upload node's own size check runs before the upload; the form's upload checks the size in its own words.
  ImageUploadNode.configure({ accept: o.accept ?? "image/*", maxSize: Number.MAX_SAFE_INTEGER, limit: 1, upload: o.upload, onError: o.onError }),
  // A new picture's description starts empty, not as its file's name (uploaded-alt.ts).
  UploadedAlt.configure({ uploaded: o.uploaded ?? new Map() }),
];

type Node = JSONContent;
const mapNodes = (n: Node, f: (n: Node) => Node | null): Node | null => {
  const out = f(n);
  if (!out) return null;
  return out.content ? { ...out, content: out.content.map((c) => mapNodes(c, f)).filter((c): c is Node => c !== null) } : out;
};

/**
 * The editor's document as body.ts takes it: a picture `{ attachment, alt }`, its file's id read back from its
 * address (an address that isn't one of the form's files gives no id, which checkBody() refuses); an upload box still
 * open is left out. Everything else goes as the editor wrote it, for checkBody() to judge.
 */
export function toBody(doc: JSONContent, idOf: (href: string) => string | null): JSONContent {
  return mapNodes(doc, (n) => {
    if (n.type === "imageUpload") return null;
    if (n.type !== "image") return n;
    const src = typeof n.attrs?.src === "string" ? n.attrs.src : "";
    const alt = typeof n.attrs?.alt === "string" && n.attrs.alt.trim() ? n.attrs.alt : null;
    return { type: "image", attrs: { attachment: idOf(src) ?? "", alt } };
  }) ?? { type: "doc", content: [] };
}

/** A stored body as the editor opens it: each picture the template's Image, drawn from its file. */
export function fromBody(body: JSONContent, fileHref: (id: string) => string): JSONContent {
  return mapNodes(body, (n) => (n.type === "image" && typeof n.attrs?.attachment === "string"
    ? { type: "image", attrs: { src: fileHref(n.attrs.attachment), alt: n.attrs.alt ?? null } } : n)) ?? body;
}

/** An upload through the form's latest pictures: its file's id, as the address the template's Image is drawn from. */
async function uploadVia(latest: { current: RichTextPictures | undefined }, uploaded: Map<string, string>, file: File): Promise<string> {
  const p = latest.current;
  if (!p) throw new Error("This editor doesn't take pictures.");
  const href = p.fileHref(await p.upload(file));
  uploaded.set(href, uploadedName(file));
  return href;
}

/** For an editor without pictures: no address is one of its files. */
const NO_FILE = (): string | null => null;

const MainToolbarContent = ({ onLinkClick, isMobile, pictures }: { onLinkClick: () => void; isMobile: boolean; pictures: boolean }) => (
  <>
    <ToolbarGroup>
      <UndoRedoButton action="undo" />
      <UndoRedoButton action="redo" />
    </ToolbarGroup>

    <ToolbarSeparator />

    <ToolbarGroup>
      <HeadingDropdownMenu modal={false} levels={[2, 3]} />
      <ListDropdownMenu modal={false} types={["bulletList", "orderedList"]} />
    </ToolbarGroup>

    <ToolbarSeparator />

    <ToolbarGroup>
      <MarkButton type="bold" />
      <MarkButton type="italic" />
      <MarkButton type="underline" />
      {!isMobile ? <LinkPopover /> : <LinkButton onClick={onLinkClick} />}
    </ToolbarGroup>

    {pictures && (
      <>
        <ToolbarSeparator />
        <ToolbarGroup>
          <ImageUploadButton text="Add" />
        </ToolbarGroup>
      </>
    )}
  </>
);

const MobileToolbarContent = ({ onBack }: { onBack: () => void }) => (
  <>
    <ToolbarGroup>
      <Button variant="ghost" onClick={onBack} aria-label="Back to the toolbar">
        <ArrowLeftIcon className="tiptap-button-icon" />
        <LinkIcon className="tiptap-button-icon" />
      </Button>
    </ToolbarGroup>

    <ToolbarSeparator />

    <LinkContent />
  </>
);

/**
 * A labelled rich text field: its label and hint over the template's toolbar and writing area, which is a multi-line
 * textbox named by the label. `initial` is the body it opens on (body.ts's shape); the form reads what was written
 * through `ref`. Without `pictures` it offers no picture button.
 */
export function RichTextEditor({ id, label, hint, initial, pictures, ref }: {
  id: string; label: string; hint?: string; initial?: JSONContent | null; pictures?: RichTextPictures; ref?: Ref<RichTextHandle>;
}) {
  const isMobile = useIsBreakpoint();
  const [mobileView, setMobileView] = useState<"main" | "link">("main");
  const idOf = pictures?.idOf ?? NO_FILE;

  // The schema is made once (a new set of extensions would make a new editor), so the upload it calls is the form's latest.
  const latest = useRef(pictures);
  useEffect(() => { latest.current = pictures; });
  const hasPictures = pictures !== undefined;
  const accept = pictures?.accept;
  // The upload and onError read the ref only when an upload happens, never while drawing.
  /* eslint-disable react-hooks/refs, react-hooks/exhaustive-deps */
  const extensions = useMemo(() => {
    const uploaded = new Map<string, string>();
    return extensionsFor({ accept, uploaded, upload: hasPictures ? (file) => uploadVia(latest, uploaded, file) : undefined, onError: hasPictures ? (error) => latest.current?.onError(error) : undefined });
  }, []);
  /* eslint-enable react-hooks/refs, react-hooks/exhaustive-deps */
  const editor = useEditor({
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "simple-editor", role: "textbox", "aria-multiline": "true", "aria-labelledby": `${id}-label`,
        ...(hint ? { "aria-describedby": `${id}-hint` } : {}),
      },
    },
    extensions,
    content: initial && pictures ? fromBody(initial, pictures.fileHref) : (initial ?? null),
  });

  // The template's tools work out whether they can act as each transaction draws them, and the first one comes only
  // when the writing area is first touched, so until then every tool was drawn unavailable: "Add image" on a fresh
  // form couldn't be pressed. One empty transaction, once the view is mounted (EditorContent's effect runs first),
  // draws them as they are.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  }, [editor]);

  useImperativeHandle(ref, () => ({
    getJSON: () => toBody(editor?.getJSON() ?? { type: "doc", content: [] }, idOf),
    removePicture: (attachment) => {
      if (!editor || !pictures) return;
      const src = pictures.fileHref(attachment);
      const at: { pos: number; size: number }[] = [];
      editor.state.doc.descendants((node, pos) => { if (node.type.name === "image" && node.attrs.src === src) at.push({ pos, size: node.nodeSize }); });
      if (!at.length) return;
      const tr = editor.state.tr;
      for (const { pos, size } of at.reverse()) tr.delete(pos, pos + size);
      editor.view.dispatch(tr);
    },
  }), [editor, idOf, pictures]);

  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>{label}</span>
      {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}
      <div className="rte simple-editor-wrapper">
        <EditorContext.Provider value={{ editor }}>
          <Toolbar aria-label="Formatting">
            {/* The link's own view is a phone's alone: wider, the link opens in its popover. */}
            {!isMobile || mobileView === "main"
              ? <MainToolbarContent onLinkClick={() => setMobileView("link")} isMobile={isMobile} pictures={pictures !== undefined} />
              : <MobileToolbarContent onBack={() => setMobileView("main")} />}
          </Toolbar>
          {pictures && <PictureDescription id={`${id}-alt`} />}
          <EditorContent editor={editor} role="presentation" className="simple-editor-content" />
        </EditorContext.Provider>
      </div>
    </div>
  );
}
