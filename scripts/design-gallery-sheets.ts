import Module from "node:module";

/**
 * The rich text editor's stylesheets are Sass (Tiptap's template and ours over it, src/app/components/rich-text-editor/),
 * which the app's bundler compiles. Imported by scripts/design-gallery.tsx before the gallery: each .scss file the
 * gallery's components import is noted here as it is loaded, for the script to compile and inline in that order.
 */
export const sheets: string[] = [];
(Module as unknown as { _extensions: Record<string, (m: unknown, file: string) => void> })._extensions[".scss"] = (_m, file) => { sheets.push(file); };
