"use client";
import { forwardRef, useImperativeHandle, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { Mention } from "@tiptap/extension-mention";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

/*
 * What an email template adds to the editor (docs/superpowers/specs/2026-11-28-email-templates-design.md, section 2),
 * ours, beside the template's files: a field is Tiptap's own Mention extension under the name "field", typed with "{"
 * or put in from Insert field, drawn as a chip with its label; a fixed part is a block the portal writes, drawn as a gray
 * card with its label and sample words, which can be moved (cut and paste, or dragged) but not edited or removed here.
 * The server checks the body again (src/lib/email-templates/body.ts): nothing here is trusted.
 */

export type EmailField = { id: string; label: string; sample: string };
export type EmailFixedPart = { id: string; label: string; words: string };
/** What the editor needs of one email: its fields, its fixed parts with their sample words, and whether it may hold links. */
export type EmailEditing = { fields: EmailField[]; fixed: EmailFixedPart[]; links: boolean };

export const fieldNode = (attrs: { id: string; label: string }) => ({ type: "field", attrs: { ...attrs, mentionSuggestionChar: "{" } });

type ListHandle = { onKeyDown: (p: SuggestionKeyDownProps) => boolean };
type ListProps = SuggestionProps<EmailField, { id: string; label: string }>;

/** The list "{" opens: the email's fields matching what was typed after it, picked with the arrows and Enter, or a press. */
const FieldList = forwardRef<ListHandle, ListProps>(function FieldList({ items, command }, ref) {
  const [at, setAt] = useState(0);
  const pick = (i: number) => { const f = items[i]; if (f) command({ id: f.id, label: f.label }); };
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") { setAt((x) => (x + 1) % items.length); return true; }
      if (event.key === "ArrowUp") { setAt((x) => (x + items.length - 1) % items.length); return true; }
      if (event.key === "Enter" || event.key === "Tab") { pick(Math.min(at, items.length - 1)); return true; }
      return false;
    },
  }), [items, at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return <div className="rte-suggest" role="status">No field by that name.</div>;
  return (
    <div className="rte-suggest" role="listbox" aria-label="Fields">
      {items.map((f, i) => (
        <button key={f.id} type="button" role="option" aria-selected={i === Math.min(at, items.length - 1)} className="rte-suggest-item"
          onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
          <span>{f.label}</span><small>{f.sample}</small>
        </button>
      ))}
    </div>
  );
});

/** The field node: Tiptap's Mention, renamed, its trigger "{", drawn with the field's label. */
export function emailField(fields: EmailField[]) {
  const labelOf = (id: unknown) => fields.find((f) => f.id === id)?.label ?? "a field";
  return Mention.extend({ name: "field" }).configure({
    HTMLAttributes: { class: "rte-field" },
    deleteTriggerWithBackspace: true,
    renderText: ({ node }) => `{${labelOf(node.attrs.id)}}`,
    renderHTML: ({ options, node }) => ["span", mergeAttributes({ "data-type": "field" }, options.HTMLAttributes), labelOf(node.attrs.id)],
    suggestion: {
      char: "{",
      items: ({ query }) => fields.filter((f) => f.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12),
      render: () => {
        let list: ReactRenderer<ListHandle, ListProps> | null = null;
        let unmount: (() => void) | null = null;
        return {
          onStart: (props) => {
            list = new ReactRenderer(FieldList, { props, editor: props.editor });
            unmount = props.mount(list.element as HTMLElement);
          },
          onUpdate: (props) => list?.updateProps(props),
          onKeyDown: (props) => (props.event.key === "Escape" ? false : list?.ref?.onKeyDown(props) ?? false),
          onExit: () => { unmount?.(); list?.destroy(); list = null; unmount = null; },
        };
      },
    },
  });
}

const countFixed = (doc: PmNode) => { let n = 0; doc.descendants((node) => { if (node.type.name === "fixedPart") n += 1; }); return n; };

/** A fixed part: an atom block with its label and sample words, kept in the document. */
export function emailFixedPart(parts: EmailFixedPart[]) {
  return Node.create({
    name: "fixedPart",
    group: "block",
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
      return { id: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-fixed-part"), renderHTML: (a: { id: string | null }) => ({ "data-fixed-part": a.id }) } };
    },
    parseHTML() { return [{ tag: "div[data-fixed-part]" }]; },
    renderHTML({ node, HTMLAttributes }) {
      const p = parts.find((x) => x.id === node.attrs.id);
      return ["div", mergeAttributes(HTMLAttributes, { class: "rte-fixed", contenteditable: "false" }),
        ["span", { class: "rte-fixed-label" }, `Fixed: ${p?.label ?? "written by the portal"}`],
        ["span", { class: "rte-fixed-words" }, p?.words ?? ""]];
    },
    addProseMirrorPlugins() {
      // A change that would take a fixed part out is not made, but a cut (to paste it elsewhere) and a drag are.
      return [new Plugin({
        key: new PluginKey("keepFixedParts"),
        filterTransaction: (tr, state) => {
          if (!tr.docChanged) return true;
          const ev = tr.getMeta("uiEvent");
          if (ev === "cut" || ev === "drop") return true;
          return countFixed(tr.doc) >= countFixed(state.doc);
        },
      })];
    },
  });
}
