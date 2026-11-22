---
name: Booster Rocket
description: A white-label parent portal for booster clubs, drawn as the calm category standard so a family reads what is left to do, pay and sign in seconds.
colors:
  club: "#5b2a86"
  club-on: "#ffffff"
  club-text-l: "#5b2a86"
  club-text-d: "#c9a7ea"
  club-text-lhc: "#45206a"
  club-text-dhc: "#e5d3f7"
  club-tint-l: "#f1ebf6"
  club-tint-d: "#2a2133"
  ground: "#f7f7f8"
  surface: "#ffffff"
  surface-raised: "#ffffff"
  surface-muted: "#f2f2f4"
  border: "#e3e4e8"
  border-control: "#cfd2d8"
  border-strong: "#8a8e98"
  ink: "#18191d"
  ink-2: "#5c606a"
  ink-3: "#8a8e98"
  done: "#1d7344"
  due: "#955400"
  late: "#b3261e"
  done-soft: "#e7f4ec"
  due-soft: "#fcf1df"
  late-soft: "#fceceb"
  neutral-soft: "#f0f1f3"
  ground-dark: "#0f1012"
  surface-dark: "#16181c"
  surface-raised-dark: "#1e2025"
  surface-muted-dark: "#1e2025"
  border-dark: "#2a2d33"
  border-control-dark: "#3b3f46"
  border-strong-dark: "#6f737d"
  ink-dark: "#ececee"
  ink-2-dark: "#a2a6ae"
  ink-3-dark: "#6f737d"
  done-dark: "#5fc68b"
  due-dark: "#e9a647"
  late-dark: "#ff8b7d"
  done-soft-dark: "#15291e"
  due-soft-dark: "#2e2312"
  late-soft-dark: "#33191a"
  neutral-soft-dark: "#22252a"
typography:
  page-title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.018em"
  amount:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.025em"
    fontFeature: "\"tnum\", \"lnum\""
  stat:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.018em"
    fontFeature: "\"tnum\", \"lnum\""
  card-title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.011em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  row-title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
  control:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.2
  meta:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0em"
  caption:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.3
rounded:
  badge: "4px"
  control: "6px"
  surface: "8px"
  round: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
  cell: "16px"
  cell-wide: "24px"
components:
  club-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    height: "56px"
  logo-tile:
    backgroundColor: "{colors.club}"
    textColor: "{colors.club-on}"
    rounded: "{rounded.surface}"
    size: "32px"
  button-primary:
    backgroundColor: "{colors.club}"
    textColor: "{colors.club-on}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-muted}"
  button-quiet:
    textColor: "{colors.club-text-l}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-quiet-hover:
    backgroundColor: "{colors.club-tint-l}"
  button-club:
    backgroundColor: "{colors.club-tint-l}"
    textColor: "{colors.club-text-l}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.late}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-danger-hover:
    backgroundColor: "{colors.late-soft}"
  button-disabled:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.ink-2}"
  button-sm:
    typography: "{typography.meta}"
    padding: "0 12px"
    height: "44px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "16px"
  card-wide:
    padding: "20px"
  list:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
  list-row:
    typography: "{typography.row-title}"
    padding: "10px 16px"
    height: "56px"
  status-icon:
    textColor: "{colors.ink-3}"
    size: "16px"
  badge:
    backgroundColor: "{colors.neutral-soft}"
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.badge}"
    padding: "1px 8px"
  badge-done:
    backgroundColor: "{colors.done-soft}"
    textColor: "{colors.done}"
  badge-due:
    backgroundColor: "{colors.due-soft}"
    textColor: "{colors.due}"
  badge-late:
    backgroundColor: "{colors.late-soft}"
    textColor: "{colors.late}"
  notice:
    backgroundColor: "{colors.neutral-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "12px 16px"
  notice-due:
    backgroundColor: "{colors.due-soft}"
  notice-done:
    backgroundColor: "{colors.done-soft}"
  notice-late:
    backgroundColor: "{colors.late-soft}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "44px"
  field-disabled:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.ink-2}"
  choice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "8px 16px"
    height: "56px"
  choice-checked:
    backgroundColor: "{colors.club-tint-l}"
  table-header:
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
  top-nav-link:
    textColor: "{colors.ink-2}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  top-nav-link-current:
    backgroundColor: "{colors.club-tint-l}"
    textColor: "{colors.club-text-l}"
  tab:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    height: "64px"
  tab-current:
    textColor: "{colors.club-text-l}"
  avatar:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.round}"
    size: "2.25rem"
---

# Design System: Booster Rocket

The stylesheet (`src/app/booster.css`) is what the browser reads and is the source of every value here; `src/lib/theme/palette.ts` mirrors its fixed colors and `tests/unit/design-tokens.test.ts` holds the two together and measures every pair. The components are the primitives in `src/app/components/ui/` (import from `@/app/components/ui`), indexed in `docs/agents/ui.md` and drawn in every state in the living gallery (`/staff/design-system`, and its static twin `design/system/gallery.html`). Parent Home (`src/app/(parent)/page.tsx`) is the reference surface.

## Overview

**Creative North Star: "The Calm Standard"**

Booster Rocket reads like a quiet, well-organized product of its category: structure comes from spacing, grouping and a strict type scale, not from heavy rules, boxes inside boxes or drop shadows. A near-white ground carries white surfaces with a 1px hairline and an 8px corner; Inter is the one face; near-black ink and one gray carry every word. The club's own color is an accent and nothing more: the primary button, the current place in the menu, the focus ring and the small logo tile in a white top bar.

The system is white-label. Each club supplies one color at runtime and the app derives every club role from it, checked against every ground of every display mode. The club leads; Booster Rocket is credited in the footer ("Runs on Booster Rocket"), never featured. The same layout is drawn in four display modes (light, dark, and high contrast for each), at three text sizes, with reduced motion and under Windows contrast themes; only token values change between them.

Parents are every age, often on older phones, so the category's density is translated humanely: body text is 1rem, nothing is set under 0.8125rem, every control is at least 44px tall, and WCAG 2.2 AA holds throughout. Staff at laptops get the same world denser, in DataTables, never smaller than that floor. Status is always words plus a small drawn icon, in four tones only.

**Key Characteristics:**
- Near-white ground, white surfaces, 1px hairlines, corners of 8px (surfaces), 6px (controls) and 4px (badges).
- One face, Inter, self-hosted; tabular figures only where a figure is read as a figure.
- The club's color derived at runtime into fill, ink-on-fill, text and tint roles, used as an accent only.
- Lists over tables for what a person acts on: a section label over one bordered list of rows, each a status ring, a title, a meta line, then an amount or a compact action.
- Four status tones (done, due, late, neutral), always words plus an icon.
- No shadow anywhere except under menus and popovers.

## Colors

A neutral near-white and near-black palette with one runtime club accent and three field-status colors, defined for four display modes.

### Display modes
Modes are attributes on `<html>`, set before paint by `src/app/display-script.ts` from the person's choices on the Display page, stored on the device (`localStorage`, key `br-display`). Every mode's default is "Match my device", which removes the attribute so the media query decides.
- **Theme** `data-theme` `light | dark`; default follows `prefers-color-scheme`.
- **Contrast** `data-contrast` `standard | more`; default follows `prefers-contrast: more`. High contrast swaps in the `--hc-*` values: every line (`border`, `border-control`, `border-strong`) becomes full ink, text reaches 7:1, `ink-3` takes `ink-2`'s value, and the focus ring grows from 2px to 3px.
- **Text** `data-text` `large | larger` sets the root to 112.5% / 125%. All type is in rem, so every size grows and layouts reflow instead of clipping.
- **Motion** `data-motion` `reduce` removes every transition and animation (a busy spinner holds still); default follows `prefers-reduced-motion`.
- Any element may carry `data-theme` / `data-contrast` with `.theme-sample` to show a mode in place (the gallery does).

The light and dark values are in the frontmatter (dark keys end `-dark`). The high-contrast values live in the stylesheet's `@tokens light-hc` / `dark-hc` blocks and `PALETTE.lightHc` / `PALETTE.darkHc` in `palette.ts`: light HC is a white ground with `#000000` ink, `#2b2e34` secondary ink, `#18191d` lines and status `#0f5530` / `#6b3a00` / `#8a1a14`; dark HC is a black ground with `#ffffff` ink, `#e2e4e8` secondary ink, `#ececee` lines and status `#8eeab1` / `#ffc978` / `#ffb0a6`.

### Primary (runtime, per club)
The frontmatter values are the default club's purple (`DEFAULT_COLOR`). **The app derives these; a club is never asked for them** (`deriveClubTokens()`, `src/lib/theme/contrast.ts`, written onto `<html>` as custom properties by `src/app/layout.tsx`; an invalid stored color falls back to the default with a server warning):
- **Club Fill** (`club`): the color the club picked, the same in every mode. Fills the primary button, the logo tile, the current step's track in the step indicator, and the club preview on the Club settings page.
- **On Club** (`club-on`): ink on the club fill, the same in every mode: white or `#14161a`, whichever has the higher contrast against the fill.
- **Club Text** (`club-text`, resolved per mode from `club-text-l` / `-d` / `-lhc` / `-dhc`): the club color as text, link, quiet button, checked control, current nav item and focus ring. Darkened (light) or lightened (dark), same hue and saturation, until it reaches 4.5:1 against the hardest ground of its mode (`surface-muted`, `CLUB_TEXT_GROUND`), or 7:1 in high contrast; the light and dark tones are then checked again on the club tint.
- **Club Wash** (`club-tint-l` / `-d`): the club color mixed 8% into the light surface, 14% into the dark one. The current nav item, the current tab's icon pill, a checked choice tile, the club button and quiet-button hover, text selection, the account control while Display is open.

### Tertiary (status, per mode)
- **Field Green** (`done`): done, paid, signed, finished steps.
- **Due Amber** (`due`): still to do, due soon, a student with more to do, the note for figures that are not current, needs attention.
- **Past-Due Red** (`late`): past due, a problem (something that didn't go through), a field's error, the danger button's words.
- Each has a soft tint (`done-soft`, `due-soft`, `late-soft`) for badges and notices; `neutral-soft` is the fourth tint, for neutral badges and information notices. The tone's ink and plain `ink` both pass on its tint.

### Neutral
- **Near-White Ground** (`ground`): the page behind everything.
- **Surface** (`surface`): cards, lists, the club bar, the tab bar, fields, buttons that are not filled. `surface-raised` is the menus' surface (lighter than `surface` in dark).
- **Muted Surface** (`surface-muted`): hover fills, a total row, a table's group rows, the disabled fill, code samples.
- **Hairline** (`border`): every 1px divider and surface edge. **Control Edge** (`border-control`): secondary buttons, option tiles, the Menu button. **Strong Edge** (`border-strong`): a text field's or tick box's edge, at 3:1 so the control can be seen.
- **Ink** (`ink`): text and headings. **Secondary Ink** (`ink-2`): meta lines, hints, labels, table headers, inactive nav and tabs; 4.5:1 on every ground. **Mark Gray** (`ink-3`): drawn marks only (a neutral status ring, an empty state's icon), at 3:1; never text.
- `--overlay` (black 8% in light, white 10% in dark) is the hover wash laid over a filled button. `--focus` is the focus ring's color: the element's own `club-text` (`:root, [data-theme], [data-contrast]` set it from `--club-text`, so a sample wrapper in another mode draws its own). Every focus ring is `var(--ring) solid var(--focus)`.

### Named Rules
**The Accent-Only Rule.** The club fill is for the primary button, the logo tile and the current step's track. Everywhere else the club appears as `club-text` or `club-tint`. The top bar and the tab bar are white surfaces, never the club's color.

**The Derived Club Rule.** A club picks one color; the app computes `club-on`, the four `club-text-*` tones and both `club-tint-*` washes. No club color can produce text under 4.5:1 (7:1 in high contrast) on any ground of its mode; `club` and `club-on` never change between modes.

**The Four Tones Rule.** A status has one of four tones: done, due, late, neutral (`Tone`, `src/app/components/ui/tone.ts`). Information is ink on the neutral tint, never a blue. No fifth status color.

**The Measured Pair Rule.** A fixed color added to the stylesheet is added to `palette.ts` in the same commit and its text pairs meet 4.5:1 (7:1 high contrast), its marks 3:1, or the token test fails.

## Typography

**Face:** Inter (self-hosted through `next/font/google` in `src/app/layout.tsx`, fetched at build time and served from the portal; a variable font), falling back to `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.

**Character:** One plain, neutral face for everything, with weight (400, 500, 600; 700 only for the club logo tile) and a short scale doing the work that a second face did before. Headings are 600 with a slight negative tracking; labels are sentence case, never uppercase.

### Hierarchy
The scale is six steps (`--text-xs` 0.8125rem to `--text-2xl` 2rem) plus `--text-control` (0.9375rem), the control size; rem against a 16px root (18px Large, 20px Larger).
- **Amount** (600, 2rem, 1.15, tabular): the one large figure (the amount owed on Payments, a buy-out's amount). Home's Total owed sets it at 1.5rem beside its title.
- **Page title** (600, 1.5rem, 1.75rem from 760px, 1.25): the page's `h1` in `PageHeader`.
- **Stat** (600, 1.5rem, tabular): one figure on a staff page.
- **Card title** (600, 1.125rem, 1.35): a `Card`'s heading; `h3` inside a card is 1rem 600.
- **Body** (400, 1rem, 1.5): default text; prose held to about 70ch.
- **Row title** (500, 1rem): a `ListRow`'s title, a table's row header.
- **Control** (500, `--text-control` 0.9375rem): buttons, top-nav links, the Menu button; also the size of a card's quiet line, a notice's body, table cells and hints that sit as a paragraph (`.help`).
- **Meta** (400, 0.875rem): a row's meta line, field hints, as-of lines, the step indicator's heading.
- **Label** (500, 0.875rem, `ink-2` for `SectionLabel`, `ink` for a field's label): the small heading over a list, a field's label.
- **Caption** (500, 0.8125rem): table column headers, tab labels, badges, avatar initials, the step indicator's numbers. The floor: nothing smaller.

### Named Rules
**The One Face Rule.** Inter for every word and figure. The only other faces are the system fallback on the offline page and in the static gallery (Inter comes through `next/font`), and the icon renderer's bundled Geist on the app icon.

**The Rem Floor Rule.** Every font size is in rem, from the scale, never under 0.8125rem; body text is 1rem.

**The Figures-as-Figures Rule.** Tabular lining figures only where a figure lines up or is read as an amount: `.num`, a DataTable's `numeric` cells and times, a list's amount, money, stats, step numbers. The body keeps Inter's proportional figures (its tabular hyphen is set wide).

## Layout

One centered column, `max-width: 1120px`, with a page gutter (`--cell`) of 16px on a phone and 24px from 760px (never less than the safe-area inset). Space is on a 4px base: 4, 8, 12, 16, 24, 32, 48. A page's `main` is a grid with a 16px gap (24px from 760px).

- **Phone (below 760px):** one column; a white 56px club bar at the top and, on parent pages, a fixed bottom tab bar (64px tabs plus the bottom inset), the body padded 88px so content clears it and the keyboard's focus is scrolled clear of it. Staff open a Menu panel from a Menu button. A DataTable's rows stack, label beside value. A list row's amount and action stack at its end below 480px.
- **760px and up:** the tab bar hides and the links move into the club bar's top nav, the account avatar at its right edge. Parent Home is two columns, 3fr and 2fr: the lists (To do, Students) on the left; the total owed and the details on the right. A parent page's single cards keep to a 760px column; staff pages use the whole width for tables, with prose at about 70ch. Choice tiles sit in `--cols` columns (3 by default).
- **The staff bar wraps** onto further rows when its links need more than one (`.bar-rows`); the parent bar never wraps and is always 56px.
- **Inside a card**, lists, tables and money lines run to the card's edges (`--box-pad`, 16px, 20px from 760px), so a row's hairline meets the card's edge.

**The 44 Rule.** Every control and lone link is at least 44px tall: buttons (compact `size="sm"` is narrower, not shorter), fields, tabs (64px), menu links (48px in the phone panel), disclosure summaries, a link alone on its line (`.link-line`), a table's links.

## Elevation & Depth

Flat. Depth comes from tone (a white surface on a near-white ground, a muted fill for hover and totals) and from 1px hairlines. The one shadow is under things that float over the page: the top nav's group panel and the phone's Menu panel. Inset box-shadows that appear elsewhere are drawn lines, not elevation: the account control's ring on hover, a checked choice tile's doubled edge, a student marker's ring, and high contrast's 1px inner edge on notices and badges.

### Shadow Vocabulary
- **Menu** (`--shadow-menu`: `0 8px 24px -6px rgb(16 17 20 / 0.14), 0 1px 3px rgb(16 17 20 / 0.08)` in light; `0 8px 24px -6px rgb(0 0 0 / 0.6), 0 1px 3px rgb(0 0 0 / 0.5)` in dark): menus and popovers only.

### Named Rules
**The Menu-Only Shadow Rule.** Cards, lists, buttons, notices and bars never cast a shadow. If something needs emphasis, it gets a tone, a weight or a position.

## Shapes

Gently rounded and consistent: 8px for surfaces (cards, lists, notices, menus, choice tiles, the logo tile, the offline page's card), 6px for controls (buttons, fields, the current nav item, the skip link, the Menu button), 4px for badges and tick boxes, and a full round only for people and status marks: avatars and the account control, status rings, the step indicator's student markers, radio marks, and the current tab's tinted icon pill. Edges are 1px hairlines; a field's and tick box's edges use the stronger edge color. The step indicator's track segments are 4px tall with a 2px corner.

**The Three Corners Rule.** A new element takes 8px if it is a surface, 6px if it is a control, 4px if it is a label. Nothing else is a pill.

## Components

Every component below is a primitive; import it from `@/app/components/ui` unless another path is named. `docs/agents/ui.md` holds the same index with what not to do; the gallery draws each one in every state.

### Club bar (`ClubBar`, `src/app/components/club-bar.tsx`; `ParentFrame`, `ParentTabs`)
A white 56px bar with a hairline foot: the club's logo tile (the short name in `club-on` on the `club` fill, 32px tall, 8px corner, decorative), the club's name (1rem 600, ellipsized), the menu, and the account avatar.
- **Account:** a link to the parent's Display page (staff: the staff home), a 44px target with a 36px `surface-muted` disc of initials; its accessible name starts with the initials it shows. On its own page it takes the club tint and club text.
- **Skip to the page:** the first Tab stop of every bar with links, drawn only while focused as a secondary button at the top of the bar in the page's flow; it lands on `PageStart`, past the bar and the "Viewing <family>. Switch family" line.

### Navigation (`src/app/components/top-nav.tsx`, `parent-tabs.tsx`; `staffMenu()`, `src/app/staff/(app)/staff-menu.ts`)
- **Phone, parent:** a fixed white tab bar with a hairline top, one equal column per `PARENT_NAV` tab (Home, Forms, Payments, Volunteer, Family): a line icon over a 0.8125rem label in `ink-2`. The current tab's label is `club-text` at 600 and its icon sits on a `club-tint` pill: never the color alone.
- **760px and up:** links in the bar, 0.9375rem 500 `ink-2`, 44px, 6px corner; hover `surface-muted`; the current one `club-text` on `club-tint` at 600.
- **Staff menu (grouped):** Home, the groups (Families, Season, Money), Settings as one entry, then Admin; an entry shows only to someone who may open its page, a group only when it holds one. A group is a button drawn like a link with a 12px caret that turns over when open. It opens on click or keyboard only, never hover, as a disclosure; its links drop into a `surface-raised` panel with a hairline, an 8px corner and the menu shadow, right-aligned to the button. One group open at a time; it closes on Escape (focus back to the button), on tabbing out, on choosing a link and on a press outside. The group holding the current page is marked like a current link. Below 760px the Menu button opens one full-width panel: Home, each group's links under its name (0.8125rem `ink-2`, a hairline above), Settings, links 48px tall; it scrolls within the screen.

### Page header (`PageHeader`)
The way back when there is one (a 44px `ink-2` link with a chevron), the page title, one quiet `ink-2` line (`lede`, Home's at 0.875rem: the season and step, and "Payments as of <time>"), and the page's actions to the right, wrapping under on a phone. Settings pages start with `<BackToSettings />` instead.

### Cards (`Card`)
A white surface, 1px hairline, 8px corner, 16px padding (20px from 760px), no shadow. A title (`title` + `titleId` name the region), an optional quiet line (`description`, `ink-2` 0.9375rem), `headActions` beside the title, `actions` at the foot. Never a card inside a card.

### Lists (`List`, `ListRow`, `ListSubRow`, `ListTotal`, `SectionLabel`, `StatusIcon`)
The core of the look. A `SectionLabel` (a real heading, 0.875rem 500 `ink-2`, sentence case) over one bordered list; a hairline between rows; each row at least 56px with 10px 16px padding: a 16px status ring, a title (500) over a meta line (0.875rem `ink-2`, its parts joined by a dot), then a right-aligned tabular amount and a compact action (`size="sm"`). A status with words puts them first on the meta line in the tone's color; a status without words draws only its ring, for a row whose meta line already says the state. A row's parts are `ListSubRow`s, indented under its title with a hairline above each, never a card inside a row. Inside a `Card`, a list runs to the card's edges; with something after it in the card it keeps a hairline under its last row.
- **Total** (`ListTotal`): under a list of amounts (Payments' open invoices), "Total" and the sum on `surface-muted` at 600, its figure in the rows' amount column. Over a total, from 480px each row's amount comes after its action, so the figures make one right-aligned column; on a phone the amount stands over the action, as in every list.
- **Status ring** (`StatusIcon`, decorative): shape tells the tone as well as color does: done a filled disc with a tick, due a ring with a quarter filled, late a filled disc with a bar, neutral a dashed ring in `ink-3`.

### Buttons (`Button`, `LinkButton`, `buttonClass()`)
`Button` does something; `LinkButton` goes somewhere (`plain` for a full load or an outside address). 44px tall, 6px corner, 0.9375rem 500, color transitions at 120ms ease-out.
- **Primary:** the club fill with `club-on` ink; hover lays the overlay wash over it. One per area.
- **Secondary:** white with the control edge and ink; hover `surface-muted`.
- **Quiet:** words in `club-text`, no edge; hover `club-tint`.
- **Club:** `club-text` on `club-tint`; hover adds a `club-text` edge.
- **Danger:** white, control edge, words in `late`; hover `late-soft` with a `late` edge.
- **Small** (`size="sm"`): 12px side padding and 0.875rem; still 44px tall.
- **Busy and disabled** share one look: `surface-muted` fill, hairline edge, `ink-2` words, not-allowed cursor, no hover. `busy` adds a spinner and is `aria-disabled`, never `disabled` (a disabled button drops the focus); the caller ignores presses. In high contrast it is white with a dashed ink edge; under forced colors dashed with `GrayText`.

### Badges (`Badge`, `StatusBadge`)
A short label on a tint: 0.8125rem 500, 1px 8px padding, 4px corner. `Badge` takes a tone or `club` (a role, a count; `club` is a label style, not a status tone); `StatusBadge` is a tone's icon and words (the tone's own word when none is given). In high contrast a 1px inner edge in the tone; under forced colors a `CanvasText` border.

### State words (`StateWords`, `src/app/components/state-words.tsx`)
A state inside a row or cell: a 16px icon and 0.875rem 500 words. Done is a tick in `done`; to do is the status icon's due mark in `due` (the product's one to-do mark); waived is a struck circle in `ink-2`, for a requirement the club let a family or student off (the reason is never shown to the family).

### Notices (`Notice`, `ActionOutcome`, `src/app/components/notice.tsx`)
A status that stands apart from the text around it, or what an action answered. On its tone's soft tint with a hairline edge and an 8px corner, 12px 16px padding: a 20px icon and the tone's word in the tone's ink, the body in `ink` at 0.9375rem.
- One status vocabulary: a notice's tones are the four status tones, its props keeping their own names. `info` is neutral "Note" (circled i, `ink` on `neutral-soft`); `warning` is due "Needs attention" (triangle, `due`); `done` is done "Done" (tick, `done`); `problem` is late "Problem" (circled cross, `late`). The classes are `notice-neutral`, `notice-due`, `notice-done`, `notice-late`.
- **With a title** a notice is a section of its own (the staff home's warnings): a 1rem 600 heading, the word read out before it but not drawn, its link or button under the text.
- **Announced:** a problem is an alert, every other tone a status; one that is simply part of the page as it loads is announced as neither (`live="none"`).
- **Taking the focus:** an answer drawn in place of the form that was pressed (a parent's change saved, a sign-in setting changed) takes the focus, so the keyboard keeps its place: `Notice` takes a `ref` and `tabIndex={-1}`, `ActionOutcome` a `ref`.
- `ActionOutcome` turns a server action's `{ ok, message }` or `{ ok: false, errors }` into a done or problem notice (information for `waiting`, needs attention for `attention`).

### Fields (`TextInput`, `TextArea`, `Select`, `Checkbox`, `Field`; `ChoiceGroup`, `src/app/components/choice-group.tsx`)
- **Text fields, text areas, selects:** a 0.875rem 500 label above, a 44px white control with a 1px strong edge and a 6px corner, 8px 12px padding; hover darkens the edge to `ink-2`; focus wears the ring and a `club-text` edge. A hint (`ink-2` 0.875rem) and an error (`late`, 500, with an icon) are tied by `aria-describedby`; an invalid control's edge is `late`. Fields fill their column and never run past it; a text area grows downward only; a select draws its own `ink-2` chevron (the platform's under forced colors). Disabled: `surface-muted`, hairline edge, `ink-2`.
- **Check boxes and radio marks** (`.checks`): an 18px mark drawn inside a 44 by 44 control, 1.5px strong edge, 4px corner (a circle for radio); checked fills with `club-text` and a white tick (radio: a `club-text` dot); the focus ring hugs the mark.
- **Choice group:** radio buttons drawn as tiles: the whole 56px tile is the control, a control edge and an 8px corner, an 18px radio mark, the option's name (1rem 500) and an optional `ink-2` description. Hover `surface-muted`; checked a `club-text` edge doubled by a 1px inset, `club-tint` fill and a filled mark. The legend is 1rem 600 with an optional hint. Stacked on a phone, `--cols` columns from 760px.
- **Password fields:** a text field with its rule said in words above it, in "characters"; choosing one asks for it twice ("Type it again"), each `autocomplete="new-password"`, with no username.

### Tables (`DataTable`, `src/app/components/data-table.tsx`)
For many records with the same columns (roster, Parents, Balances, audit, the forms matrix, progress). Inside its card at 760px and up: a caption in `ink-2` 0.875rem (or read out only), sentence-case 0.8125rem 500 `ink-2` headers over a hairline, a hairline between rows, cells at 0.9375rem with 10px 12px padding, the row's name a row header (500), numeric columns right-aligned in tabular figures, a quiet column of buttons at the row's end; hover `surface-muted` where hover exists; group rows on `surface-muted` at 600. Below 760px each row stacks: a hairline above it, the name first, then each cell as its 0.8125rem label beside its value; the page never scrolls sideways. Every part keeps its table role. Rows come in the page's own order with no sort controls; the column they follow says so (`sorted`, `aria-sort`). A wide table with a column per item (the forms matrix) scrolls inside its own focusable region at laptop widths, its names column held in place. A row whose facts don't fit keeps them in a `details.more` in its last column.

### Money rows and total (Home's To do and Total owed; Payments' money box: `src/app/(parent)/money-box.tsx`, `due-line.tsx`)
- **One row per open invoice** (`InvoiceRows`, a `ListRow` each, on Home and Payments): what it is ("Invoice QZ-1041, Xochitl"), its due line in words (Payments adds the invoice's date after it), the amount right-aligned in tabular figures, its compact Pay, and a ring before it in the tone of its due date (neutral later, due soon, late past). A buy-out's invoice adds "Paying instead of volunteering: <title>".
- **Urgency on the date line only:** later `ink-2` ("Due Nov 22"); soon `due` 500 with the distance ("Due Nov 15, in 8 days"); past `late` 500 ("Was due Oct 30"). Amounts never change color. "Soon" and "past" are counted from the club's own date in its time zone (`clubToday()`), for an invoice and a season requirement alike, so every parent of a club reads the same words on the same day.
- **One Pay per invoice:** QuickBooks pays one invoice at a time. The soonest-due payable invoice gets the primary Pay with an arrow; every other one a secondary Pay. Each Pay's accessible name states the amount and the invoice. Pay is a plain link in the same tab to QuickBooks' payment page (`noopener noreferrer`, no referrer). An invoice with no pay link has no Pay, and the help line says the treasurer can tell them how to pay it.
- **As of:** the figures always carry their source and time ("Owed now. From QuickBooks, as of 2:14 pm."; "Nothing owed." when nothing is), and Home's page line repeats "Payments as of <time>".
- **Total:** Home's Total owed card shows the amount once beside its title, the as-of line, the help line ("Each invoice opens on QuickBooks' secure payment page. … Need more time? Ask the treasurer. They're happy to work something out.") and "See your payments". Payments' money card says the total beside its title (the family's name), as Home's does, and sums its rows to a Total row on `surface-muted` (`ListTotal`). Invoices in more than one currency get no single total, and a line says so.
- **Paid up:** a `done` tick and "You're all paid up. Thank you!". A credit: "The boosters may be holding a credit for you…". Payments lists paid invoices of the last 12 months, each a row with the `done` ring and "Paid" first on its meta line.
- **Figures that are not current:** the last known figures stay, and a note in `due` on `due-soft` (0.875rem 500, `role="status"`) stands over Home's To do list and under the as-of line on Payments: "We couldn't get the latest figures from QuickBooks just now. These are the last ones we have. Paying here is paused until we can. Need to pay sooner? Ask the treasurer." Every Pay stays in its place, `aria-disabled`, and says why in its accessible name ("Pay $85.00, paused until the figures are up to date"). The causes are not all an outage, so it never says QuickBooks is down and never promises when paying will be back.
- **Payments not connected:** a family the portal can tell has no link to the club's books (`notConnected` from `loadFamilyMoney()`) gets the money card with its heading ("What you owe") and one `role="status"` line: "The club hasn't connected your payments to the portal yet. Until then, the treasurer can tell you what you owe." No figure, as-of line, invoice, Pay, paid list, not-current note or "See your payments"; it names no system and gives no reason. Whenever the portal can't tell, the card says "We can't show what you owe right now. Please check back in a little while.", so a linked family never reads the not-connected words.

### Step indicator (`StepIndicator`; Home's season ruler, `src/app/(parent)/season-parts.tsx`)
The club's season steps as a thin segmented track, each step's number and name under its segment. Not a control.
- **Heading:** a 0.875rem `ink-2` line, "Fall 2026 · **Step 2 of 4**", the current part in `ink` 600; on a phone the current step's name is always in it, so a hidden label loses nothing. Beside it, "See the whole season" (`club-text`, 44px), wrapping under when there is no room. "All N steps done" when every step is; "Nothing to do yet" when the season asks nothing of the family, and then nothing is ticked.
- **Steps:** done steps have a `done` track and a ticked number, with a hidden ", done"; the current step (`aria-current="step"`) has a `club` track and its number and name in `club-text` 600, with a hidden ", current step"; future steps a hairline track and `ink-2`. Only a step behind the current one is ticked; one left unfinished there has no tick and a hidden ", not finished".
- **Labels that don't fit:** each step is a size container; under 76px wide its label hides and the number stays; labels clamp to two lines. With more than six steps on a phone every label hides.
- **Students on the current step:** one 22px marker each with the student's initial: done is a `done` disc with a white initial; still to do a white disc with a `due` ring and initial. Decoration: the Students list says the same in words.

### Smaller primitives
- **EmptyState:** a centered 28px `ink-3` icon, a 1rem 600 title, a kind `ink-2` line of what will be here, and the one action.
- **Stat** (several in `.stats`): a 0.875rem `ink-2` label over a 1.5rem 600 tabular figure. Staff pages only.
- **KeyValue** (`dl.details`): `ink-2` 0.875rem labels beside values; long values wrap where they stand.
- **Toolbar:** filters in a wrapping row over what they scope, actions at its end.
- **Avatar:** initials on a `surface-muted` disc (2.25rem; 1.75rem small; `club` variant on the tint).
- **LocalTime, CalendarDate, `formatMoney()`** (`@/lib/money/cents`): an instant in the viewer's zone, a calendar date the same for everyone, an amount. Never formatted by hand.
- **Hint** (`.hint`, `.help`): an `ink-2` line explaining what is above it; never a state. **Link line** (`.link-line`): a lone link, 44px. **Box foot / row actions / one button:** the buttons that close a card, two or more side by side, a button with its answer under it.
- **Visually hidden** (`.visually-hidden`): words a screen reader reads that the page doesn't draw (which invoice a Pay pays).

### Settings view (`SETTINGS_SECTIONS`, `src/app/staff/(app)/settings/`)
A card per part: its title, a state in words with an icon, a KeyValue of what is set, and one button to that part's own page. No inputs on the view; step pages use the fields above and answer every action with `ActionOutcome`. Two columns from 760px. The club step of setup and the Club page show the chosen color in a 56px preview strip (`club` fill, `club-on` name, 8px corner) before saving.

### Display page (`src/app/(parent)/display/`)
Reached from the account avatar. One card of four choice groups in order: **Appearance** (Match my device, Light, Dark), **Contrast** (Match my device, Standard, High contrast), **Text size** (Standard, Large, Larger), **Motion** (Match my device, Reduce motion; two columns). "Match my device" is first and the default. Changes apply at once; a closing `ink-2` note: "Saved on this device. Sign in somewhere else and you can choose again there." The install hint is permanent here.

### Focus
`:focus-visible` everywhere: a `--focus` (`club-text`) outline, 2px (3px in high contrast), 2px offset (1px on fields, hugging the mark on tick boxes). High contrast also thickens link underlines to 2px. The skip link's landing point takes the focus with no ring.

### Windows contrast themes (forced colors)
Under `forced-colors: active` the system palette wins; the build keeps every state readable without its own colors: the bars and the logo tile, account and avatars get `CanvasText` edges; the current nav link and tab are underlined 3px; menus get `CanvasText` borders; the step track is `GrayText`, done steps `CanvasText`, the current one `Highlight` and 6px tall with its words underlined; student markers draw on `Canvas` with a `CanvasText` ring (done inverted); money rings and paid marks in `CanvasText`; badges and notices get a `CanvasText` border and the notice icon `CanvasText`; choice tiles and tick boxes draw themselves (checked in `Highlight`, focus a 3px dashed `CanvasText` outline on tiles); selects use the platform's arrow; disabled is dashed with `GrayText`; focus rings use `Highlight`. QR codes and the club preview keep their own colors (`forced-color-adjust: none`).

### Installed app (`src/app/manifest.ts`, `src/lib/pwa/`, `public/offline.html`, `public/sw.js`)
One app for the whole portal, built from the club's settings on each request.
- **Icon:** a square of `club` with the club's short name in `club-on`, in the renderer's bundled Geist Regular, held to the middle 60% (84% on the 48px favicon, which nothing crops). Sizes 192 and 512 (each for any use and as maskable), 180 for iOS, 48 for the tab. A short name the font can't draw gets the plain mark: a ring with a dot in `club-on`.
- **Label:** the club's name when 12 characters or fewer, otherwise its short name.
- **Theme color:** the top bar's surface, white in light and `#16181c` in dark (`THEME_COLOR`); the manifest's theme color is the light surface and its splash background the light ground, not the club's color, which is on the icon. iOS status bar style `default`.
- **Safe areas:** the viewport covers the screen; the bar adds the top inset, gutters are the larger of the gutter and the side inset, the tab bar adds the bottom and side insets, the body's bottom padding is 88px plus the bottom inset (the inset alone from 760px and on pages with no tab bar). Zoom is never disabled. This block is last in the stylesheet.
- **Offline page:** a single white card (max 420px, 8px corner, hairline) on the ground: a no-connection icon, "You're offline", "The portal needs a connection to load. Check your Wi-Fi or mobile data, then try again.", and a full-width ink-filled **Try again** that asks for the same address again. System font, inline styles, all four modes by media query, `CanvasText` edges under forced colors; no club color or name, no family data, no script, the same for everyone, because it is the one thing the service worker stores.
- **Install hint:** a card "Add the portal to your home screen": an Install button once the browser offers its prompt, or on iPhone and iPad the steps (Share, Add to Home Screen, Add), preceded by opening the page in Safari inside another app's browser. Permanent on the Display page; under the sign-in form an offer with **Not now**, dismissed on that device and left out when there is nothing to offer. Never inside the installed app.

### Copy patterns
The voice is PRODUCT.md's warm, plain neighbor, kind about money. State facts plainly ("Was due Oct 30", never "OVERDUE"); count what is left ("1 thing left to do in Uniforms", "1 of 2 done"); name the person or thing on the button ("Sign", "Pay" with the invoice in its accessible name); offer help with a person, not a penalty ("Need more time? Ask the treasurer. They're happy to work something out."); thank people ("You're all paid up. Thank you!"); when something can't be read, say what still works and who can help, and say when it will be back only if the portal knows. A refusal says the same thing whatever the reason. US English, sentence case.

## Do's and Don'ts

### Do:
- **Do** derive `club-on`, the four `club-text-*` tones and both `club-tint-*` washes from the club's one color, and check every pair reaches 4.5:1 (7:1 in high contrast) on the hardest ground of its mode.
- **Do** build pages from the primitives in `@/app/components/ui`; add a sample to the gallery and regenerate `design/system/gallery.html` when a primitive or state is added.
- **Do** use tokens only in components: no hex, rgb or named color, and add any new fixed color to `palette.ts` in the same commit.
- **Do** put a short list a person acts on in a `List` under a `SectionLabel`, and many like records in a `DataTable`.
- **Do** say every status in words with an icon, in one of the four tones: done, due, late, neutral.
- **Do** keep every control and lone link at least 44px tall, and a parent page's busy button `aria-disabled`.
- **Do** set type in rem from the scale, never under 0.8125rem, and let layouts reflow at 125% text.
- **Do** give each invoice its own Pay, the soonest-due payable one primary, and an as-of line beside the figures.
- **Do** check a new surface in light, dark, both high-contrast sets and a Windows contrast theme.
- **Do** make "Match my device" the first and default choice of every display setting, stored on the device.

### Don't:
- **Don't** fill the club bar, the tab bar or any surface with the club's color; it is an accent for the primary button, the logo tile, the current step's track, the current nav item and focus.
- **Don't** cast a shadow from anything but a menu or popover (`--shadow-menu`).
- **Don't** nest a card in a card, or put a panel inside a list row.
- **Don't** set a label in uppercase or put an eyebrow over a page title; a section label names the list under it.
- **Don't** add a fifth status color or a blue information tone; information is ink on the neutral tint.
- **Don't** use `ink-3` for text, or color alone for any meaning.
- **Don't** make a pill: full rounds are for avatars, status marks, radio marks and the current tab's icon pill.
- **Don't** color an amount; urgency goes on the date line only.
- **Don't** hide a Pay when the figures are not current; pause it in place and say why.
- **Don't** promise when a service will be back unless the portal knows.
- **Don't** load fonts from Google in the app or set type in px.
- **Don't** use an emoji or a Unicode glyph as an icon; icons are drawn SVG.
