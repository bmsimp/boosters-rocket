"use client";
import { useCurrentEditor, useEditorState } from "@tiptap/react";
import { TextInput } from "@/app/components/ui";
import { ALT_MAX } from "@/lib/messages/body";

/**
 * The description of the picture selected in the editor, for families who use a screen reader or whose picture
 * doesn't load: the template's Image node's own `alt`, set in a field shown while a picture is selected. Ours, beside
 * the template rather than in it (src/app/components/tiptap/README.md).
 */
export function PictureDescription({ id }: { id: string }) {
  const { editor } = useCurrentEditor();
  const picture = useEditorState({
    editor,
    selector: ({ editor: e }) => (e?.isActive("image") ? { alt: (e.getAttributes("image").alt as string | null | undefined) ?? "" } : null),
  });
  if (!editor || !picture) return null;
  return (
    <div className="rte-picture">
      <TextInput id={id} label="What the picture shows" maxLength={ALT_MAX} value={picture.alt}
        onChange={(e) => editor.chain().updateAttributes("image", { alt: e.target.value || null }).run()}
        hint="For families who use a screen reader, or whose picture doesn't load." />
    </div>
  );
}
