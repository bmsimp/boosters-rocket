# UI, in depth

What this covers: the components pages are built from, the tokens, the sections of `booster.css`, the gallery, and the installed app, beside the UI rules in `AGENTS.md`. The rules of `AGENTS.md` still apply.

The look is the calm category standard (the owner's choice of 2026-11-21, `PRODUCT.md`): a near-white ground, white surfaces with a 1px hairline and an 8px corner, Inter, sentence-case labels, and the club's color as an accent only (primary buttons, the current nav item, focus rings, the logo tile). Structure comes from spacing, grouping and the type scale, never from heavy rules, boxes inside boxes or drop shadows.

## Components

Import from the index: `import { Card, List, ListRow, LinkButton } from "@/app/components/ui";` (server components unless the file says `"use client"`). See each one in every state at `/staff/design-system` (Admin menu), or in `design/system/gallery.html` without the app.

| Need | Use | Don't |
| --- | --- | --- |
| A page's title, its one quiet line, its actions, the way back | `PageHeader` | a bare `h1.page-title` with buttons beside it |
| A titled region (what a family owes, a setting, a form) | `Card` (`title` + `titleId` name the region; `actions` at the foot, `headActions` beside the title) | a card inside a card; a `<section class="box">` written by hand |
| A short list a person acts on (To do, Students, Payments) | `List` + `ListRow` (`status`, `title`, `meta` (one part or a list, dotted), `amount`, `action`; `sub` of `ListSubRow` for a row's parts, indented) | a table for five rows; a list of cards; a panel inside a row |
| Many records with the same columns (roster, Balances, audit) | `DataTable` | a hand-made `<table>`; sorting controls (say the order with `sorted`) |
| The small heading over a list or table | `SectionLabel` | an uppercase label; an eyebrow over a page title |
| Doing something | `Button` (`primary`, `secondary`, `quiet`, `danger`, `club`; `size="sm"` in a row; `busy`) | more than one primary in an area; `disabled` for busy on a parent page |
| Going somewhere, styled as a button | `LinkButton` (`plain` for a full load or an outside address) | a `<button>` that navigates |
| A state in a row or cell, in words with an icon | `StateWords` (done, todo, waived) or `StatusBadge` (a tone, its icon, its words) | color alone; a colored dot with no words |
| A short label (a role, a count) | `Badge` | a pill: corners are 4px, full circles are for avatars and status dots |
| The ring before a row | `StatusIcon` (inside `ListRow` already) | an emoji or a Unicode glyph |
| A status that stands apart, or what an action answered | `Notice` (info, warning, done, problem) and `ActionOutcome` | a bare status paragraph; an alert for anything but a problem |
| Nothing here yet | `EmptyState` (what will be here, and the one action) | "No data"; an empty table |
| One figure that matters on a staff page | `Stat` (several in `.stats`) | a hero number on a parent page: the amount sits in its card |
| A text field, a few lines, a dropdown, a tick box | `TextInput`, `TextArea`, `Select`, `Checkbox` (each takes `id`, `label`, `hint`, `error`) | a placeholder instead of a label; an error in color alone |
| A few options that need explaining | `ChoiceGroup` | a dropdown of two |
| Facts about one thing, label beside value | `KeyValue` | a two-column table |
| Filters over a list or table | `Toolbar` | filters scattered above several cards |
| Where something stands in a few steps | `StepIndicator` (the season ruler) | a progress bar with no words |
| A person's initials | `Avatar` | an initial in a square |
| An instant, a calendar date, an amount | `LocalTime`, `CalendarDate`, `formatMoney()` (`@/lib/money/cents`) | formatting them yourself |

Rules:
- No new one-off class where a primitive does the job. A page block that needs one goes in its area's block of `booster.css` (below), built from tokens.
- No hex color, rgb or named color in a component: tokens only. A fixed color the stylesheet gains is added to `src/lib/theme/palette.ts` in the same commit, where `tests/unit/design-tokens.test.ts` checks it matches the stylesheet and passes its contrast in every mode.
- Font sizes in rem, from the scale, never under 0.8125rem (`--text-xs`); body text is 1rem. Figures are tabular only where they are read as figures: `.num` (and `numeric` on a DataTable column, `KeyValue`'s `numeric`), amounts, stats, a table's times; the body keeps Inter's proportional figures, whose tabular hyphen is set wide.
- Every control and lone link is at least 44px tall (buttons, fields, tabs, menu links, `.link-line`). `size="sm"` is narrower, not shorter.
- Every status is words plus an icon; color only repeats them. The current nav item and tab carry the club's color and weight (and the tab its tinted icon pill).
- Only menus and popovers have a shadow (`--shadow-menu`). Lists and tables inside a `Card` run to its edges by themselves (`--box-pad`).

## Tokens

Section 1 of `booster.css`; the fixed colors are mirrored in `src/lib/theme/palette.ts` (ratios for every pair and mode are in the gallery's Contrast section).

- Color roles: `--ground` (the page), `--surface` (cards, bars, fields), `--surface-raised` (menus), `--surface-muted` (hover, total rows, code), `--border` (hairlines), `--border-control` (secondary buttons, option tiles), `--border-strong` (a field's or tick box's edge: 3:1), `--ink`, `--ink-2` (secondary text: 4.5:1 on every ground), `--ink-3` (drawn marks only, never text: 3:1), `--done`, `--due`, `--late`, `--info` with `--done-soft`, `--due-soft`, `--late-soft`, `--info-soft`, `--neutral-soft` (tints for badges and notices; their ink passes on them), `--overlay` (the hover wash on a fill), `--focus` is `--club-text`.
- Club roles (runtime, `src/lib/theme/contrast.ts`, set on `<html>` by `src/app/layout.tsx`): `--club` (fill) and `--club-on` (its ink), `--club-text` (text, links, rings: 4.5:1 against the hardest ground of its mode, 7:1 in high contrast) and `--club-tint` (current nav item, hover).
- Display modes: light and dark (`data-theme` or the device), high contrast for each (`data-contrast="more"`: lines in full ink, 7:1 text, a 3px ring), text size Large and Larger (`data-text`), reduced motion (`data-motion` or the device: nothing moves), and forced colors (section 6). Any element can carry `data-theme`/`data-contrast` with `.theme-sample` to show a mode in place.
- Type: `--font` (Inter through `next/font`, `--font-sans`); `--text-xs` 0.8125rem, `--text-sm` 0.875rem, `--text-md` 1rem, `--text-lg` 1.125rem, `--text-xl` 1.5rem (page title; 1.75rem from 760px), `--text-2xl` 2rem (an amount). Weights 400, 500, 600.
- Space: `--s1` 4px, `--s2` 8px, `--s3` 12px, `--s4` 16px, `--s5` 24px, `--s6` 32px, `--s7` 48px; `--cell` is the page gutter, 16px on a phone and 24px from 760px.
- Corners: `--radius` 8px (surfaces), `--radius-control` 6px (buttons, fields), `--radius-badge` 4px, `--radius-round` (avatars, status dots). `--ring` 2px (3px in high contrast). Motion: `--dur-fast` 120ms, `--dur` 200ms, `--ease`.

## The sections of `booster.css`

1. Tokens. 2. Base (reset, body, headings, links, selection, focus). 3. Layout (`.wrap`, `main.wrap` and its two columns from 760px, `.stack`, footer). 4. Components, A to Z: Account and Avatar, Badge, Club bar, Buttons, Card (`.box`), Choice group, Data table, Details list, Disclosure, Empty state, Fields and checks, Lists, Menu (top nav, groups, the phone's Menu panel), Notice, Page header, Section label, Stat, State lines, Status icon, Step indicator (`.season`, `.sets`), Tabs, Toolbar. 5. Page blocks, each marked "Keep new rules for them inside this block": Home and Family (money lines, students, Home's columns, sign-in), Season, Volunteer, Forms (the signing frame, the matrix), Staff pages (setup, audit, the staff home, the gallery's `.ds-*`), Settings and the staff menu. 6. Accessibility: the parent pages' fixes (`.link-line`, the skip link, scroll padding), reduced motion, high-contrast extras, forced colors. 7. The installed app (safe areas, the install hint), which must stay last (`tests/unit/pwa-static.test.ts`).

## The gallery

`/staff/design-system` (`src/app/staff/(app)/design-system/`, permission `Settings.Club.Read`, an Admin menu entry) draws `Gallery` (`gallery.tsx`): sample content only, no reads, not audited. A new primitive or state gets a sample there in the same commit, then `pnpm tsx scripts/design-gallery.tsx` writes the static twin `design/system/gallery.html` (the same components and stylesheet, inlined, fetching nothing; it shows the fallback face, as Inter comes through `next/font`).

## Installed app

- The manifest (`src/app/manifest.ts`) and the icons are built on each request from the club's settings and hold no hostname; the manifest's theme and background color are the club's (the splash). Icon names are `ICONS` in `src/lib/pwa/icons.ts`. `InstallHint` and `RefreshOnResume` (`src/app/components/pwa/`) are given no club or family data.
- The page's `theme-color` is the top bar's surface: white in light, `#16181c` in dark (`THEME_COLOR`, `src/lib/theme/palette.ts`), by `prefers-color-scheme`.
- `public/offline.html` is drawn in the same look with its own inline styles and the system font, the same for every club.
