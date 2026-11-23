import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSchema } from "@tiptap/react";
import { RichTextEditor } from "@/app/components/rich-text-editor";
import { extensionsFor, fromBody, toBody } from "@/app/components/rich-text-editor/rich-text-editor";
import { checkBody } from "@/lib/messages/body";
import { EditorState } from "@tiptap/pm/state";
import { clearUploadedAlt, uploadedName } from "@/app/components/rich-text-editor/uploaded-alt";

/**
 * The shared rich text editor (src/app/components/rich-text-editor/, a thin copy of Tiptap's Simple Editor template)
 * offers what src/lib/messages/body.ts keeps and nothing else (spec section 6): checkBody() refuses everything else on
 * the server whatever the editor sends, so a tool for it would only make a message that can't be saved.
 */
const ALLOWED_NODES = ["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "hardBreak", "text", "image"];
const ALLOWED_MARKS = ["bold", "italic", "underline", "link"];
const ID = "8b7c2a4e-1f3d-4c5b-9a6e-0d1c2b3a4f5e";
const href = (id: string) => `/staff/messages/files/${id}`;
const idOf = (src: string) => (src === href(ID) ? ID : null);

describe("RichTextEditor", () => {
  it("knows only the nodes and marks a checked body holds, and the template's upload box, which never leaves it", () => {
    const schema = getSchema(extensionsFor({}));
    expect(Object.keys(schema.nodes).sort()).toEqual([...ALLOWED_NODES, "imageUpload"].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...ALLOWED_MARKS].sort());
    expect(schema.nodes.heading!.spec.attrs?.level).toBeDefined();
  });

  it("turns the template's pictures into body.ts's, drops an open upload box, and opens a stored body the other way", () => {
    const edited = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Team photo" }] },
        { type: "image", attrs: { src: href(ID), alt: "The whole team", title: "team", width: null, height: null } },
        { type: "imageUpload", attrs: { accept: "image/*", limit: 1, maxSize: 1 } },
        { type: "image", attrs: { src: "https://evil.example/x.png", alt: "" } },
      ],
    };
    const body = toBody(edited, idOf);
    expect(body.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Team photo" }] },
      { type: "image", attrs: { attachment: ID, alt: "The whole team" } },
      { type: "image", attrs: { attachment: "", alt: null } },
    ]);
    // A picture from anywhere but the form's files is refused by the server's check.
    expect(checkBody(body, new Set([ID])).ok).toBe(false);
    expect(checkBody({ ...body, content: body.content!.slice(0, 2) }, new Set([ID]))).toMatchObject({ ok: true, pictures: [ID] });
    expect(fromBody({ type: "doc", content: [{ type: "image", attrs: { attachment: ID, alt: "Team" } }] }, href))
      .toEqual({ type: "doc", content: [{ type: "image", attrs: { src: href(ID), alt: "Team" } }] });
  });

  it("starts a new picture's description empty, not as its file's name, and keeps one typed afterwards", () => {
    const schema = getSchema(extensionsFor({}));
    const uploaded = new Map<string, string>();
    let state = EditorState.create({ schema, plugins: [clearUploadedAlt(uploaded)] });
    const name = uploadedName(new File([new Uint8Array(1)], "IMG_2041.jpg"));
    expect(name).toBe("IMG_2041");
    // The upload box inserts the template's Image with the file's name as its alt and title, as the template does.
    uploaded.set(href(ID), name);
    const insert = (alt: string) => state.apply(state.tr.insert(0, schema.nodes.image!.create({ src: href(ID), alt, title: alt })));
    state = insert(name);
    const picture = () => { let n: { alt: unknown; title: unknown } | null = null; state.doc.descendants((x) => { if (x.type.name === "image") n = { alt: x.attrs.alt, title: x.attrs.title }; }); return n; };
    expect(picture()).toEqual({ alt: null, title: null });
    expect(uploaded.size).toBe(0);
    expect(toBody(state.doc.toJSON(), idOf).content!.find((n) => n.type === "image")).toEqual({ type: "image", attrs: { attachment: ID, alt: null } });
    // Typed afterwards, even as the file's name, a description stays.
    let pos = -1;
    state.doc.descendants((x, p) => { if (x.type.name === "image") pos = p; });
    state = state.apply(state.tr.setNodeMarkup(pos, undefined, { src: href(ID), alt: "IMG_2041", title: null }));
    expect(picture()).toEqual({ alt: "IMG_2041", title: null });
  });

  it("draws a labelled frame around the template's toolbar, named Formatting", () => {
    const html = renderToStaticMarkup(h(RichTextEditor, { id: "b", label: "Message", hint: "Some words." }));
    expect(html).toContain('<span class="field-label" id="b-label">Message</span>');
    expect(html).toContain('<p class="field-hint" id="b-hint">Some words.</p>');
    expect(html).toMatch(/role="toolbar"[^>]*aria-label="Formatting"|aria-label="Formatting"[^>]*role="toolbar"/);
  });
});
