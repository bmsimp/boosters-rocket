# Tiptap's Simple Editor template, as its CLI copies it

Everything in this folder but this file and `LICENSE` is Tiptap's MIT "Simple Editor" template
(https://tiptap.dev/docs/ui-components/templates/simple-editor, source github.com/ueberdosis/tiptap-ui-components),
exactly as `npx @tiptap/cli add simple-editor` wrote it. Keep it that way, so a later version can be copied over it and
the difference read as Tiptap's alone. What is ours lives beside it, in `src/app/components/rich-text-editor/`:

- `rich-text-editor.tsx`: a thin copy of `tiptap-templates/simple/simple-editor.tsx`, keeping only the tools whose
  nodes and marks `src/lib/messages/body.ts` keeps, the upload pointed at the form's route, and the body's shape
  converted on the way in and out (`fromBody()`, `toBody()`);
- `picture-description.tsx`: the selected picture's description, the Image node's own `alt`;
- `email-nodes.tsx` and `insert-field-menu.tsx`: an email template's fields (Tiptap's own Mention extension, renamed `field`, its trigger `{`) and fixed parts, and Insert field, built from the template's dropdown menu;
- `rich-text-editor.scss`: the look, mapping the template's variables and classes onto the portal's tokens. It brings in
  `styles/_variables.scss` and `styles/_keyframe-animations.scss`, the global styles the CLI asks a project to import,
  inside a cascade layer, so the portal's own styles win over them.

`tiptap-templates/simple/simple-editor.tsx`, its `.scss` (which loads a font from Google, never loaded here),
`theme-toggle.tsx`, `data/content.json` and the tools we leave out are kept as they came, unused.

## The version here

- `@tiptap/cli` 3.21.2, run on 2026-11-23 against its registry (https://template.tiptap.dev): the item `simple-editor`
  and the 92 items it depends on. The registry gives no version of its own; the tree's fingerprint below tells one copy
  from another.
- Fingerprint: `9ec3a81705d71c5a` (the first 16 characters of the SHA-256 of `sha256sum` over every file here but
  `README.md` and `LICENSE`, sorted by path, run from this folder: `find . -type f ! -name LICENSE ! -name README.md |
  sort | xargs sha256sum | sha256sum`).
- The CLI's demo page (`app/simple/page.tsx`) and its `scss.d.ts` were not copied in: the first would be a route of the
  portal, and the second isn't needed.
- The packages it imports are in `package.json`, each pinned: the `@tiptap/*` ones at the portal's Tiptap version
  (3.33.0), `@tiptap/extension-mention` and its peer `@tiptap/suggestion` among them for an email's fields, and `@base-ui/react`, `@floating-ui/react`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-popover`,
  `class-variance-authority`, `clsx`, `lodash.throttle`, `react-hotkeys-hook`; `sass` and `@types/lodash.throttle` as
  dev dependencies.
- It is left out of `pnpm lint` (`eslint.config.mjs`); `pnpm typecheck` and every test still read it.

## Edits inside this folder

None. An edit that can't be avoided is marked in the file with a `// boosters-rocket:` comment and listed here.

## Refreshing it from upstream

1. In an empty folder outside the repo, make a scratch project: a `package.json` naming `next`, `react` and
   `react-dom`, a `tsconfig.json` with `"paths": { "@/*": ["./src/*"] }`, `src/app/layout.tsx`, and this
   `components.json`, so the CLI writes the imports this folder uses:

   ```json
   { "rsc": true, "tsx": true, "aliases": { "components": "@/app/components/tiptap", "contexts": "@/app/components/tiptap/contexts", "hooks": "@/app/components/tiptap/hooks", "tiptapIcons": "@/app/components/tiptap/tiptap-icons", "lib": "@/app/components/tiptap/lib", "tiptapExtensions": "@/app/components/tiptap/tiptap-extension", "tiptapNodes": "@/app/components/tiptap/tiptap-node", "tiptapUi": "@/app/components/tiptap/tiptap-ui", "tiptapUiPrimitives": "@/app/components/tiptap/tiptap-ui-primitive", "tiptapUiUtils": "@/app/components/tiptap/tiptap-ui-utils", "styles": "@/app/components/tiptap/styles" } }
   ```

2. Run `npx @tiptap/cli@<version> add simple-editor` there (`< /dev/null`, so it asks nothing).
3. Replace this folder's files with its `src/app/components/tiptap/` (keep `README.md` and `LICENSE`), and read the diff.
   Put back any edit listed above.
4. Compare the scratch `package.json` with ours: add a new package, or move one, pinned to an exact version at least two
   weeks old, the `@tiptap/*` ones all at one version.
5. Update this file's version, date and fingerprint; run `pnpm typecheck`, `pnpm lint`, `tests/unit/rich-text-editor.test.ts`,
   `tests/unit/no-raw-html.test.ts` and the messages tests; and look at the editor in light, dark and high contrast at
   390 and 1440 wide (the design-system gallery has one; `pnpm tsx scripts/design-gallery.tsx` writes its static twin).
