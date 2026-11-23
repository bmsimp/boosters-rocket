import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSchema } from "@tiptap/react";
import { RichTextEditor } from "@/app/components/rich-text-editor";
import { extensionsFor } from "@/app/components/rich-text-editor/rich-text-editor";

/**
 * The shared rich text editor (src/app/components/rich-text-editor/) offers what src/lib/messages/body.ts keeps and
 * nothing else (spec section 6): checkBody() refuses everything else on the server whatever the editor sends, so a
 * tool for it would only make a message that can't be saved.
 */
const ALLOWED_NODES = ["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "hardBreak", "text", "image"];
const ALLOWED_MARKS = ["bold", "italic", "underline", "link"];

describe("RichTextEditor", () => {
  it("knows only the nodes and marks a checked body holds", () => {
    const schema = getSchema(extensionsFor(undefined));
    expect(Object.keys(schema.nodes).sort()).toEqual([...ALLOWED_NODES].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...ALLOWED_MARKS].sort());
    expect(Object.keys(schema.nodes.image!.spec.attrs ?? {}).sort()).toEqual(["alt", "attachment"]);
  });

  it("draws a labelled frame whose toolbar's buttons are each named in words, with a picture button only for a form that takes pictures", () => {
    const names = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    const plain = renderToStaticMarkup(h(RichTextEditor, { id: "b", label: "Message", hint: "Some words." }));
    expect(plain).toContain('<span class="field-label" id="b-label">Message</span>');
    expect(plain).toContain('<p class="field-hint" id="b-hint">Some words.</p>');
    expect(plain).toContain('role="toolbar" aria-label="Formatting"');
    expect(names(plain)).toEqual(["Undo", "Redo", "Heading", "Subheading", "Bulleted list", "Numbered list", "Bold", "Italic", "Underline", "Link"]);
    const withPictures = renderToStaticMarkup(h(RichTextEditor, { id: "b", label: "Message",
      pictures: { fileHref: (id) => `/f/${id}`, add: async () => null, busy: false, accept: "image/png", hint: "PNG." } }));
    expect(names(withPictures)).toEqual([...names(plain), "Picture"]);
    // Every drawing is decoration: the button's name says what it does.
    expect([...withPictures.matchAll(/<svg[^>]*>/g)].every((m) => m[0].includes('aria-hidden="true"'))).toBe(true);
  });
});
