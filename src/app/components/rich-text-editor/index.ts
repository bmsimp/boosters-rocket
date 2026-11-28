/**
 * The rich text editor (docs/agents/ui.md): one shared client component for a body checked by src/lib/messages/body.ts,
 * a thin copy of Tiptap's Simple Editor template (src/app/components/tiptap/). Club messages use it, and so does an
 * email template's page (`email`: fields and fixed parts, src/lib/email-templates/body.ts).
 */
export { RichTextEditor, type RichTextHandle, type RichTextPictures } from "./rich-text-editor";
export type { EmailEditing, EmailField, EmailFixedPart } from "./email-nodes";
