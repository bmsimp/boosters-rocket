# Boosters Rocket brand kit

The brand kit, as the owner gave it (the second kit, of 2026-11-22, from Claude Design): the guide, the tokens, the
logo files and their exports. It lives at `brand/` in the repo.

- `BRAND.md` — the brand guide: co-branding rules, logo use, color, type, voice.
- `tokens.css` / `tokens.json` — the brand's design tokens (see "In this repo" for how the app uses them).
- `logos/` — outlined SVGs for code: every word is converted to paths, so no font is needed; the `-mono` files use
  `currentColor`.
- `exports/` — ready-to-use files: outlined SVG, transparent PNG, vector PDF and EPS, a website icon set (`icons/`) and
  social images and README banners (`social/`). `exports/README.md` says which file is for what. The kit's `print/`
  folder (1.8 MB of 4096 px marks and 3600 px-wide lockup PNGs) is not kept here: its README says to prefer the PDF or
  EPS for a printer, and those are kept. Ask the owner for the kit if a print PNG is ever needed.
- `social-preview.png` — the repository's social preview (the kit's `exports/social/github-social-preview-1280x640.png`),
  set by hand in the repository's Settings, General, Social preview.
- `logos/qb-app-icon.png` — not part of the kit: the owner's 100 x 100 icon for the Boosters Rocket app's listing with
  Intuit (the QuickBooks app's icon in Intuit's developer portal). Kept here so it is versioned with the rest.

## In this repo

- **Fonts.** `tokens.css` starts with a Google Fonts `@import` (Bricolage Grotesque and Inter). That import is for
  brand surfaces outside the app only (the website, the social images). The app never loads it and never loads a font
  from Google: it self-hosts Inter through `next/font` (`src/app/layout.tsx`), and does not use Bricolage Grotesque at
  all. The kit's lockups and "Powered by" badges draw the wordmark as outlines, so showing one loads no font.
- **Tokens.** `tokens.css` and `tokens.json` are the brand's source values, not the app's stylesheet. The app's tokens
  live in `src/app/booster.css` (mirrored in `src/lib/theme/palette.ts` and measured by
  `tests/unit/design-tokens.test.ts`), with sizes in rem: the kit's px scale is not imported. The status colors and the
  badge ink there are the kit's, checked against the app's own grounds (`DESIGN.md`, Colors).
- **The badge.** The footer's "Powered by Boosters Rocket" (`src/app/components/powered-by.tsx`) is the kit's outlined
  `powered-by-mono.svg` and `powered-by-color-light.svg`, inlined so its inks come from the app's tokens (one ink,
  `--badge-ink`; in color, the `--br-*` tokens, which follow the display mode). Its coordinates are rounded to two
  places; the files here are the originals.
- **The setup pages' icon** (`src/app/setup/product-mark.tsx`) is the kit's `logos/app-icon-small.svg`, inline.
- **The club's own app icons** are the club's monogram, not the product's (`src/app/icons/[name]/route.ts`): nothing
  here replaces them.
- **The rules for agents** are in `AGENTS.md` ("Brand & UI"), adapted from the kit's snippet below: the club leads, the
  product is a "Powered by Boosters Rocket" badge, tokens in `src/app/booster.css`. Where the snippet and `AGENTS.md`
  differ (the snippet's `brand/tokens.css` and its Bricolage headings), `AGENTS.md` applies.
- **Use of the name and logos:** `TRADEMARKS.md` at the repo's root.

## For Claude Code (the kit's snippet)

The kit suggests this for the repo's `CLAUDE.md`; this repo's version is in `AGENTS.md`:

```md
## Brand & UI
- Follow `brand/BRAND.md` for all UI, copy and asset decisions. Use tokens from `brand/tokens.css`.
- The portal is co-branded: the CLUB's accent (`--club-accent` → `--app-accent`) drives buttons, links and active states. Never hard-code Boosters Rocket indigo/red into portal UI.
- Status colors (paid/due/overdue/info) are fixed tokens and always pair color + icon + word.
- Footer of every portal page: one-color "Powered by Boosters Rocket" badge (`brand/logos/powered-by-mono.svg`, color `--app-badge-ink`), linking to https://boostersrocket.com. Sign-in page and emails use the full-color badge.
- Money copy is calm and never shaming. Money amounts use tabular numerals.
- Fonts: Inter for UI; Bricolage Grotesque only for display headings.
```

All SVGs have text converted to outlines, so they render identically everywhere without the fonts installed.

## Other companies' marks

The Integrations page in Settings draws the mark of each system the portal can connect to, small, in a tile before its
name. These marks belong to their owners, are not Boosters Rocket's, and are not covered by the repository's license or
by `TRADEMARKS.md`. They are used only to say which system a row is for, as each vendor publishes them for that, and are
never recolored, cropped into something else or made larger than the tile. The files are in `public/integrations/`.

| File | Mark | Source |
| --- | --- | --- |
| `microsoft.svg` | The Microsoft logo (four squares), © Microsoft | Microsoft's "Sign in with Microsoft" branding guidelines, `ms-symbollockup_mssymbol_19.svg`, unchanged: https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps. Used for the Microsoft 365 mail row and the Microsoft staff sign-in row. |
| `documenso.svg` | The Documenso mark, © Documenso | Documenso's public source repository (AGPL-3.0), `apps/remix/app/components/general/branding-logo-icon.tsx` at commit `80550e78b3e4852f87e9968e24b1984c427e4430` (https://github.com/documenso/documenso): its `<svg>` element and paths unchanged, written out as a file. Documenso publishes no brand kit; this is the mark its own app draws, one ink (`currentColor`), so the page fills it with its own ink, in light and dark. |
| `google.svg` | The Google "G", © Google | Google's Sign in with Google branding guidelines, `signin-assets.zip`, the light square button without text (`Theme=Light, Show text=No, Shape=Square`), with the button's white tile and border taken out and the frame cut to the "G": https://developers.google.com/identity/branding-guidelines. |
| `quickbooks/qb-ball.svg`, `quickbooks/qb-logo-black.png`, `quickbooks/qb-logo-white.png` | The QuickBooks ball and the full QuickBooks logo, © Intuit Inc. | Intuit's files, as the owner downloaded them from Intuit, unchanged: the ball is `sbseg-logo-qb-ball-50-50-gwp-wr-us.svg`; the full logo is 2345 x 600, black for a light page and white for a dark one. `quickbooks/TRADEMARK.txt` says whose they are. The ball is on the QuickBooks row of Integrations and the QuickBooks page's head; the full logo is for the connect step (Connect through Boosters Rocket's slice 3). |

**QuickBooks' sizes.** Intuit publishes two rules, and the portal meets the stricter of each: design.intuit.com says
the symbol is never drawn under 16px; the partner guidelines PDF says never under 26px, with clear space of half the
symbol's height on every side. So the ball is drawn at 26px with 13px clear inside its tile's border (`.logo-qb` in
`src/app/booster.css`, a 64 x 54 tile on a row and 54 x 54 on the page head, larger than the others), and the full
logo, when it is drawn, at least 2rem tall with clear space of half its ball's height. Neither is recolored, cropped,
outlined or put on a tile of color: the ball keeps its green and white in light and dark, and the full logo changes
file with the theme. These numbers are the ones the spec recorded from Intuit's pages on 2026-11-24
(`docs/superpowers/specs/2026-11-24-connect-through-boosters-rocket-design.md`, section 9); on 2026-11-24 the builder
could not read them again (design.intuit.com redirects its QuickBooks pages to its home page for a reader without
script, and Intuit's static developer docs answered 403), so check them against Intuit's current page before a
release.

SMTP is not a vendor: its tile is a plain envelope drawn by the app.
