import { Extension } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";

/**
 * A new picture's description starts empty. The template's upload box inserts its Image with the file's name as `alt`
 * (and `title`), and a name such as IMG_2041 is poor words for a screen reader, which would reach families. Ours,
 * beside the template rather than in it: the wrapper notes each upload's address and the name the box will give it
 * (`uploaded`), and the first time that picture appears with that name, the name is taken off. A description typed
 * afterwards, even one equal to the name, is kept.
 */
export const uploadedName = (file: File) => file.name.replace(/\.[^/.]+$/, "") || "unknown";

export function clearUploadedAlt(uploaded: Map<string, string>): Plugin {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!uploaded.size || !transactions.some((t) => t.docChanged)) return null;
      let tr = null as ReturnType<typeof state.tr.setNodeMarkup> | null;
      state.doc.descendants((node, pos) => {
        if (node.type.name !== "image") return;
        const name = uploaded.get(node.attrs.src as string);
        if (name === undefined) return;
        uploaded.delete(node.attrs.src as string);
        if (node.attrs.alt !== name && node.attrs.title !== name) return;
        tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, { ...node.attrs, alt: null, title: null });
      });
      return tr;
    },
  });
}

/** The plugin as an extension, given the wrapper's map of uploads not yet seen. */
export const UploadedAlt = Extension.create<{ uploaded: Map<string, string> }>({
  name: "uploadedAlt",
  addOptions() { return { uploaded: new Map() }; },
  addProseMirrorPlugins() { return [clearUploadedAlt(this.options.uploaded)]; },
});
