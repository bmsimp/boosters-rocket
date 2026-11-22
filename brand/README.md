# Boosters Rocket brand kit

The brand kit, as the owner gave it: the guide, the tokens and the logo files. It lives at `brand/` in the repo.

## In this repo

- **Fonts.** `tokens.css` starts with a Google Fonts `@import` (Bricolage Grotesque and Inter). That import is for
  brand surfaces outside the app only (the README's images, the website, the social preview). The app never loads it
  and never loads a font from Google: it self-hosts Inter through `next/font` (`src/app/layout.tsx`), and does not use
  Bricolage Grotesque at all.
- **Tokens.** `tokens.css` and `tokens.json` are the brand's source values, not the app's stylesheet. The app's tokens
  live in `src/app/booster.css` (mirrored in `src/lib/theme/palette.ts` and measured by
  `tests/unit/design-tokens.test.ts`), with sizes in rem: the kit's px scale is not imported. The status colors and the
  badge ink there are the kit's, checked against the app's own grounds (`DESIGN.md`, Colors).
- **The rules for agents** are in `AGENTS.md` ("Brand & UI"), adapted from the snippet below: the club leads, the
  product is a "Powered by Boosters Rocket" badge, tokens in `src/app/booster.css`.
- **Use of the name and logos:** `TRADEMARKS.md` at the repo's root.

- `BRAND.md` — the brand guide: co-branding rules, logo use, color, type, voice.
- `tokens.css` / `tokens.json` — design tokens.
- `logos/` — SVG logo, icon, and "Powered by" files. Mono files use `currentColor`.

## For Claude Code

Add this to the repo's `CLAUDE.md`:

```md
## Brand & UI
- Follow `brand/BRAND.md` for all UI, copy and asset decisions. Use tokens from `brand/tokens.css`.
- The portal is co-branded: the CLUB's accent (`--club-accent` → `--app-accent`) drives buttons, links and active states. Never hard-code Boosters Rocket indigo/red into portal UI.
- Status colors (paid/due/overdue/info) are fixed tokens and always pair color + icon + word.
- Footer of every portal page: one-color "Powered by Boosters Rocket" badge (`brand/logos/powered-by-mono.svg`, color `--app-badge-ink`), linking to https://boostersrocket.com. Sign-in page and emails use the full-color badge.
- Money copy is calm and never shaming. Money amounts use tabular numerals.
- Fonts: Inter for UI; Bricolage Grotesque only for display headings.
```

Lockup and "Powered by" SVGs use live text (Bricolage Grotesque / Inter). In the app, render them as HTML text + the mark SVG instead, or convert the text to outlines for print.
