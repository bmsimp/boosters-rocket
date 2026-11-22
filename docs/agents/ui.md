# UI, in depth

What this covers: the components pages are built from, the tokens, the sections of `booster.css`, the gallery, and the installed app, beside the UI rules in `AGENTS.md`. The rules of `AGENTS.md` still apply.

The look is the calm category standard (the owner's choice of 2026-11-21, `PRODUCT.md`) under the brand kit (`brand/BRAND.md`, the owner's of 2026-11-22): a near-white ground, white surfaces with a 1px hairline and a 12px corner (controls 8px), Inter, sentence-case labels, and the club's color as an accent only (primary buttons, the current nav item, focus rings, the logo tile). The club leads; the product shows only as the "Powered by Boosters Rocket" badge. Structure comes from spacing, grouping and the type scale, never from heavy rules, boxes inside boxes or drop shadows.

## Components

Import from the index: `import { Card, List, ListRow, LinkButton } from "@/app/components/ui";` (server components unless the file says `"use client"`). See each one in every state at `/staff/settings/design-system` (Settings, under Administration), or in `design/system/gallery.html` without the app.

| Need | Use | Don't |
| --- | --- | --- |
| A page's title, its one quiet line, its actions, the way back | `PageHeader` | a bare `h1.page-title` with buttons beside it |
| A titled region (what a family owes, a setting, a form) | `Card` (`title` + `titleId` name the region; `actions` at the foot, `headActions` beside the title) | a card inside a card; a `<section class="box">` written by hand |
| A short list a person acts on (To do, Students, Payments) | `List` + `ListRow` (`status`, `title`, `meta` (one part or a list, dotted), `amount`, `action`; `href` makes the whole row one link with a chevron, its end then `trail` (words, a `StatusDot`), never `action`; `logo` a tile before the title (an integration's mark, `IntegrationLogo`); `sub` of `ListSubRow` for a row's parts, indented; `detail` for what goes under the row at its full width: a note, a place's cancel, a small form in place of its action; other attributes, a `data-*` hook, on its `li`); `ListTotal` right after a list of amounts that add up (Payments) | a table for five rows; a list of cards; a panel inside a row; a total written by hand |
| Many records with the same columns (roster, Balances, audit) | `DataTable` | a hand-made `<table>`; sorting controls (say the order with `sorted`) |
| The small heading over a list or table | `SectionLabel` | an uppercase label; an eyebrow over a page title |
| Doing something | `Button` (`primary`, `secondary`, `quiet`, `danger`, `club`; `size="sm"` in a row; `busy`; `ref` for a press the focus goes back to). Two in a row: a compact secondary (or danger) and a quiet one (Forms' Open and Download, "Yes, cancel it" and "Keep it") | more than one primary in an area; `disabled` for busy on a parent page; a tinted and an outlined button side by side |
| Going somewhere, styled as a button | `LinkButton` (`plain` for a full load or an outside address) | a `<button>` that navigates |
| A state in a row or cell, in words with an icon | `StateWords` (done, todo, waived) or `StatusBadge` (a tone: done, due, late, info, neutral; its icon, its words); a quiet one-line status beside a name (the Settings rail, an integration row) is `StatusDot` (done, due, neutral: its words with a dot that only repeats them) | color alone; a colored dot with no words |
| A short label (a role, a count) | `Badge` (`tone="club"` is a label style only, the club's wash, not a status tone) | a pill: corners are 4px, full circles are for avatars and status dots |
| The ring before a row | `StatusIcon` (inside `ListRow` already) | an emoji or a Unicode glyph |
| A status that stands apart, or what an action answered | `Notice` (info, warning, done, problem: info, due, done and late in the tone vocabulary below) and `ActionOutcome`; an answer drawn in place of the form that was pressed takes the focus (`ref`, and Notice's `tabIndex={-1}`) | a bare status paragraph; an alert for anything but a problem; a green line of words for an action's answer |
| Nothing here yet | `EmptyState` (what will be here, and the one action) | "No data"; an empty table |
| One figure that matters on a staff page | `Stat` (several in `.stats`) | a hero number on a parent page: the amount sits in its card |
| A text field, a few lines, a dropdown, a tick box | `TextInput`, `TextArea`, `Select`, `Checkbox` (each takes `id`, `label`, `hint`, `error`; `TextInput` a `ref` for a field that takes the focus) | a placeholder instead of a label; an error in color alone; your own `aria-describedby` on a `TextInput` (it is replaced: say it with `hint`) |
| A few options that need explaining | `ChoiceGroup` (an option `disabled` when it can't be chosen now) | a dropdown of two |
| Facts about one thing, label beside value | `KeyValue` | a two-column table |
| Filters over a list or table | `Toolbar` | filters scattered above several cards |
| A card's longer explanation, read once and then known | `HowThisWorks` (`summary` defaults to "How this works") | a wall of prose before the card's list or form; hiding what a reader must know before they press |
| Where something stands in a few steps | `StepIndicator` (the season ruler) | a progress bar with no words |
| A person's initials | `Avatar` | an initial in a square |
| The display choices (Appearance, Contrast, Text size, Motion), saved on the device | `DisplaySettings` (`src/app/(parent)/display/display-settings.tsx`; the staff account page passes `title`) | a copy of its choices or its storage on another page |
| An instant, a calendar date, an amount | `LocalTime`, `CalendarDate`, `formatMoney()` (`@/lib/money/cents`) | formatting them yourself |
| The product's credit | `PoweredBy` (`src/app/components/powered-by.tsx`): already in the parent frame's and the staff layout's footers; `variant="color"` under a sign-in form; a page outside both frames puts it in `<footer className="signin-foot">` | a setting that hides it; the product's name or colors anywhere else in the portal; the kit's badge SVGs as images (their text needs a face the app doesn't load) |

Rules:
- No new one-off class where a primitive does the job. A page block that needs one goes in its area's block of `booster.css` (below), built from tokens.
- No hex color, rgb or named color in a component: tokens only. A fixed color the stylesheet gains is added to `src/lib/theme/palette.ts` in the same commit, where `tests/unit/design-tokens.test.ts` checks it matches the stylesheet and passes its contrast in every mode.
- Font sizes in rem, from the scale, never under 0.8125rem (`--text-xs`); body text is 1rem. Figures are tabular only where they are read as figures: `.num` (and `numeric` on a DataTable column, `KeyValue`'s `numeric`), amounts, stats, a table's times; the body keeps Inter's proportional figures, whose tabular hyphen is set wide.
- Every control and lone link is at least 44px tall (buttons, fields, tabs, menu links, `.link-line`). `size="sm"` is narrower, not shorter.
- Every status is words plus an icon; color only repeats them. The status colors are the brand's fixed set (done/paid a tick, due a clock, late/overdue an alert, info an i) plus the neutral gray; a club never changes them. The current nav item and tab carry the club's color and weight (and the tab its tinted round icon pill, the one allowed exception to "nothing is a pill").
- Only menus and popovers have a shadow (`--shadow-menu`). Lists and tables inside a `Card` run to its edges by themselves (`--box-pad`), and a list's rows take the card's side padding, so their words line up with the card's title.

## Tokens

Section 1 of `booster.css`; the fixed colors are mirrored in `src/lib/theme/palette.ts` (ratios for every pair and mode are in the gallery's Contrast section).

- Color roles: `--ground` (the page), `--surface` (cards, bars, fields), `--surface-raised` (menus), `--surface-muted` (hover, total rows, code), `--border` (hairlines), `--border-control` (secondary buttons, option tiles), `--border-strong` (a field's or tick box's edge: 3:1), `--ink`, `--ink-2` (secondary text: 4.5:1 on every ground), `--ink-3` (drawn marks only, never text: 3:1), `--done`, `--due`, `--late`, `--info` with `--done-soft`, `--due-soft`, `--late-soft`, `--info-soft`, `--neutral-soft` (tints for badges and notices; their ink passes on them). The status tones are done, due, late, info (the brand's four fixed colors, `brand/tokens.css`'s paid, due, overdue and info, measured on our grounds) and neutral, the one vocabulary for badges, status icons, state words and notices (a Notice's `info`, `warning`, `done` and `problem` props keep their names and map to info, due, done and late: the classes are `notice-info`, `notice-due`, `notice-done`, `notice-late`). `--badge-ink` is the "Powered by" badge's one ink; `--br-*` (the product's indigo, flame and the mark's fills) draw only the sign-in page's full-color badge and the setup pages' product icon. `--overlay` is the hover wash on a fill. `--focus` is the focus ring's color, the element's own `--club-text`: every ring is `var(--ring) solid var(--focus)`, never `--club-text` written out. "To do" has one mark, `StatusIcon`'s due clock, which `StateWords` draws too.
- Club roles (runtime, `src/lib/theme/contrast.ts`, set on `<html>` by `src/app/layout.tsx`; a club that hasn't chosen a color gets the brand's Launch Indigo, `DEFAULT_COLOR`): `--club` (fill: the color as picked in light, lightened in dark until it stands 3:1 off the dark grounds; from `--club-l` / `--club-d`) and `--club-on` (its ink, per theme), `--club-text` (text, links, rings: 4.5:1 against the hardest ground of its mode, 7:1 in high contrast) and `--club-tint` (current nav item, hover; in dark at least 1.3:1 off the surface).
- Display modes: light and dark (`data-theme` or the device), high contrast for each (`data-contrast="more"`: lines in full ink, 7:1 text, a thicker 3px ring), text size Large and Larger (`data-text`), reduced motion (`data-motion` or the device: nothing moves), and forced colors (section 6). Any element can carry `data-theme`/`data-contrast` with `.theme-sample` to show a mode in place.
- Type: `--font` (Inter through `next/font`, `--font-sans`); `--text-xs` 0.8125rem, `--text-sm` 0.875rem, `--text-control` 0.9375rem (buttons, nav links, table cells, a card's quiet line, a notice's body: use the token, never 0.9375rem), `--text-md` 1rem, `--text-lg` 1.125rem, `--text-xl` 1.5rem (page title; 1.75rem from 760px), `--text-2xl` 2rem (an amount). Weights 400, 500, 600 and 700 (700 only for the club logo tile).
- Space: `--s1` 4px, `--s2` 8px, `--s3` 12px, `--s4` 16px, `--s5` 24px, `--s6` 32px, `--s7` 48px; `--cell` is the page gutter, 16px on a phone and 24px from 760px.
- Corners: `--radius` 12px (surfaces), `--radius-control` 8px (buttons, fields, the logo tile), `--radius-badge` 4px, `--radius-round` (avatars, status dots). `--ring` 2px (3px in high contrast). Motion: `--dur-fast` 120ms, `--dur` 200ms, `--ease`.

## The sections of `booster.css`

1. Tokens. 2. Base (reset, body, headings, links, selection, focus). 3. Layout (`.wrap`, `main.wrap` and its two columns from 760px, `.stack`, footer). 4. Components, A to Z: Account and Avatar, Badge, Club bar, Buttons, Card (`.box`), Choice group, Data table, Details list, Disclosure, Empty state, Fields and checks, Lists, Menu (top nav, groups, the phone's Menu panel), Notice, Page header, Powered by, Section label, Stat, State lines, Status icon, Step indicator (`.season`, `.sets`), Tabs, Toolbar. 5. Page blocks, each marked "Keep new rules for them inside this block": Home and Family (money lines, students, Home's columns, sign-in), Season, Volunteer, Forms (the signing frame, the matrix), Staff pages (setup, audit, the staff home, the gallery's `.ds-*`), Settings and the staff menu (the rail, the Overview, the Integrations page and its logo tiles, `StatusDot`). 6. Accessibility: the parent pages' fixes (`.link-line`, the skip link, scroll padding), reduced motion, high-contrast extras, forced colors. 7. The installed app (safe areas, the install hint), which must stay last (`tests/unit/pwa-static.test.ts`).

## The gallery

`/staff/settings/design-system` (`src/app/staff/(app)/settings/design-system/`, permission `Settings.Club.Read`, an item of Settings under Administration) draws `Gallery` (`gallery.tsx`): sample content only, no reads, not audited. A new primitive or state gets a sample there in the same commit, then `pnpm tsx scripts/design-gallery.tsx` writes the static twin `design/system/gallery.html` (the same components and stylesheet, inlined, fetching nothing; it shows the fallback face, as Inter comes through `next/font`).

## The account control

The initials at the end of the club bar lead to the person's own page: a parent's Display page, a staff member's account page (`/staff/account`: their name, the same `DisplaySettings`, Sign out). The page is about the signed-in person alone, takes no id and asks for no permission (the staff home and it are `STAFF_OWN_PAGES` in `tests/integration/page-guards.test.ts`). The link's name starts with the initials it shows, and it is `aria-current="page"` on that page.

## Installed app

- The manifest (`src/app/manifest.ts`) and the icons are built on each request from the club's settings and hold no hostname; the manifest's theme color is the light surface (white) and its background (the splash) the light ground, not the club's color, which is on the icon. Icon names are `ICONS` in `src/lib/pwa/icons.ts`. `InstallHint` and `RefreshOnResume` (`src/app/components/pwa/`) are given no club or family data.
- The page's `theme-color` is the top bar's surface: white in light, `#16181c` in dark (`THEME_COLOR`, `src/lib/theme/palette.ts`), by `prefers-color-scheme`.
- `public/offline.html` is drawn in the same look with its own inline styles and the system font, the same for every club. It carries no product mark or name: `tests/unit/pwa-static.test.ts` refuses "Booster" in it, since the product's name is also the default club's name before setup.
