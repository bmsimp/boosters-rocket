/**
 * The rich text editor (docs/agents/ui.md): one shared client component for a body checked by src/lib/messages/body.ts,
 * a thin copy of Tiptap's Simple Editor template (src/app/components/tiptap/). Club messages use it; an email
 * template's settings page is to use it too.
 */
export { RichTextEditor, type RichTextHandle, type RichTextPictures } from "./rich-text-editor";
