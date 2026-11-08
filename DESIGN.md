---
name: Booster Rocket
description: A white-label parent portal drawn like a marching-band dot book, so a family always knows its next set.
colors:
  club: "#5b2a86"
  club-on: "#ffffff"
  club-text: "#5b2a86"
  club-tint: "#f1ebf6"
  club-text-l: "#5b2a86"
  club-text-d: "#c9a7ea"
  club-text-lhc: "#45206a"
  club-text-dhc: "#e5d3f7"
  club-tint-l: "#f1ebf6"
  club-tint-d: "#2a2133"
  paper: "#ffffff"
  grid: "#e8eae6"
  ink: "#14161a"
  ink-2: "#4c5159"
  hair: "#d9dcd6"
  done: "#2f6b3a"
  due: "#9a4f08"
  late: "#a3261b"
  paper-dark: "#16181c"
  grid-dark: "#22252b"
  ink-dark: "#eceee9"
  ink-2-dark: "#a9aeb6"
  hair-dark: "#3a3e45"
  done-dark: "#6fcf86"
  due-dark: "#f0a24b"
  late-dark: "#ff8b7e"
  paper-hc: "#ffffff"
  ink-hc: "#000000"
  ink-2-hc: "#1f2328"
  done-hc: "#1c4d25"
  due-hc: "#6b3500"
  late-hc: "#7d1a12"
  paper-dark-hc: "#000000"
  ink-dark-hc: "#ffffff"
  ink-2-dark-hc: "#e6e6e6"
  done-dark-hc: "#8ff0a4"
  due-dark-hc: "#ffc06e"
  late-dark-hc: "#ffaaa0"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "\"tnum\", \"lnum\""
  headline:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.005em"
  club-name:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.3125rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.01em"
  set-number:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1
  setting-legend:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 700
    lineHeight: 1.45
  body:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.45
  body-row:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  set-label:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.2
  body-sm:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
  meta:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    letterSpacing: "0.08em"
  nav:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
  tab:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    letterSpacing: "0.03em"
rounded:
  none: "0px"
  person: "50%"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "48px"
  cell: "24px"
components:
  club-bar:
    backgroundColor: "{colors.club}"
    textColor: "{colors.club-on}"
    height: "56px"
  box:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "{spacing.s4}"
  set-cell:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    typography: "{typography.set-number}"
    padding: "6px 6px 14px 8px"
  set-cell-current:
    backgroundColor: "{colors.club}"
    textColor: "{colors.club-on}"
  student-dot:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.due}"
    rounded: "{rounded.person}"
    size: "20px"
  student-dot-done:
    backgroundColor: "{colors.done}"
    textColor: "{colors.paper}"
    rounded: "{rounded.person}"
    size: "20px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "0 20px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  button-line:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 20px"
    height: "44px"
  button-line-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-club:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.club-text}"
    rounded: "{rounded.none}"
    padding: "0 20px"
    height: "44px"
  button-club-hover:
    backgroundColor: "{colors.club-tint}"
    textColor: "{colors.club-text}"
  button-disabled:
    backgroundColor: "{colors.hair}"
    textColor: "{colors.ink-2}"
  button-disabled-hc:
    backgroundColor: "{colors.paper-hc}"
    textColor: "{colors.ink-2-hc}"
  choice:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "8px 16px"
    height: "56px"
  choice-hover:
    backgroundColor: "{colors.club-tint}"
  choice-checked:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.club-text}"
  tab:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    typography: "{typography.tab}"
    height: "64px"
  tab-active:
    textColor: "{colors.club-text}"
  tab-badge:
    backgroundColor: "{colors.due}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "0 6px"
---

# Design System: Booster Rocket

## Overview

**Creative North Star: "The Dot Book"**

The season is a drill, and a family always knows its next set. Every screen is a page from the dot book students carry: white chart paper ruled with a faint 24px coordinate grid, near-black 2px ink rules, square corners, and the club's own color used the way a drill writer uses a highlighter, to mark where you are now. Nothing floats; everything is drawn onto the paper.

The system is white-label. Each club supplies one color at runtime, and the app derives everything else from it (see Colors). The club leads; Booster Rocket is credited in the footer, never featured. The grid reads as plain graph paper, so a theater or sports club fits as well as a marching band.

Density is calm and phone-first: one column of ruled boxes on phones, a two-column box grid at 760px and up. Money is set like a ledger, with tabular figures in one right-aligned column that visibly sums to its total. The reference build is `design/reference/parent-home.html` (with `display-settings.html` for the Display page); every later surface, staff screens included, inherits from it.

The same page is drawn in four ink sets: light, dark ("chart paper at night", where the world's ink becomes the paper), and a high-contrast version of each. Layout, rules and shapes never change between modes; only the token values do. Windows contrast themes are honored on top of all four.

**Key Characteristics:**
- Chart paper ground: white with a 24px grid in `grid`, gutters and gaps on that grid.
- 2px `ink` rules for structure, 1px `hair` rules for list rows, no shadows, no rounded containers.
- One runtime club color, derived into per-mode roles, used for the bar, the current set, and club actions.
- Two faces: Atkinson Hyperlegible for anything read, Barlow Condensed for marks, labels and numbers on the chart.
- Status is always a word plus an icon, never color alone.
- Four display modes chosen per device, each defaulting to "match my device".

## Colors

A white-and-ink chart palette with one runtime club color and three field-status colors, drawn in four modes.

### Display modes
Modes are attributes on `<html>`, set before paint by `display.js` from the person's choices on the Display page. Choices are stored per device (`localStorage`, key `br-display`); every mode's default is "match my device", which removes the attribute and lets the media query decide.
- **Theme** `data-theme` `light | dark`; default follows `prefers-color-scheme`.
- **Contrast** `data-contrast` `standard | more`; default follows `prefers-contrast: more`.
- **Text** `data-text` `large | larger` sets the root to 112.5% / 125%. All type is in rem, so every size grows and the layout reflows rather than clipping.
- **Motion** `data-motion` `reduce` removes every transition; default follows `prefers-reduced-motion`.

### Primary (runtime, per club)
The frontmatter values are FZN's purple default. The gold demo (`#gold`) hand-sets a light club color: club `#f2c200`, club-on `#14161a`, club-text `#7a5c00` / `#f2c200` / `#5c4500` / `#ffd84d` (light / dark / light HC / dark HC), club-tint `#fdf6d6` / `#2e2a17` (light / dark). **The app must derive these, not ask clubs for them:**
- **Club Fill** (`club`): the color the club picked, unchanged in every mode. Fills the club bar, the current set cell and text selection.
- **On Club** (`club-on`): ink on the club fill, unchanged in every mode. White if white reaches 4.5:1 against the fill, otherwise `ink` `#14161a`.
- **Club Text** (`club-text`): the club color as text, link, outline button, checked option and focus ring on paper. It resolves per mode:
  - `club-text-l`: 4.5:1 on light paper. The club color itself if it passes, otherwise darkened (lower lightness, same hue). Gold becomes `#7a5c00` (6.25:1).
  - `club-text-d`: 4.5:1 on dark paper. Lightened as needed; purple becomes `#c9a7ea` (8.63:1), gold stays `#f2c200` (10.57:1).
  - `club-text-lhc` / `club-text-dhc`: 7:1 on high-contrast paper (purple `#45206a` 12.59:1 / `#e5d3f7` 14.99:1; gold `#5c4500` 9.11:1 / `#ffd84d` 15.18:1).
- **Club Wash** (`club-tint-l` / `club-tint-d`): a pale (or, in dark, deep) wash of the club color for hover on club actions and choice options only. The mode's `club-text` must still reach 4.5:1 on it (7:1 in high contrast).

### Tertiary (status, per mode)
| Role | Light | Dark | Light HC | Dark HC |
|---|---|---|---|---|
| **Field Green** (`done`): done, paid, signed, finished sets | `done` 6.39:1 | `done-dark` 9.26:1 | `done-hc` 9.82:1 | `done-dark-hc` 15.17:1 |
| **Due Amber** (`due`): to do, due soon, student still on the set, count badge, offline note | `due` 6.01:1 | `due-dark` 8.44:1 | `due-hc` 9.84:1 | `due-dark-hc` 13.02:1 |
| **Past-Due Red** (`late`): only the date line of a past-due invoice | `late` 7.37:1 | `late-dark` 7.83:1 | `late-hc` 10.35:1 | `late-dark-hc` 11.51:1 |

### Neutral
- **Chart Paper** (`paper`): the ground of the page, boxes, the season band, tab bar and options. Dark: `paper-dark`, near-black. High contrast: pure white / pure black.
- **Grid Line** (`grid`): the 24px coordinate grid behind the page. Decoration only. Dark: `grid-dark`. High contrast: removed (`transparent`).
- **Drill Ink** (`ink`): body text, 2px structural rules, the filled Pay button. 18.1:1 light, 15.21:1 dark; pure black / white in high contrast.
- **Pencil** (`ink-2`): secondary text: meta lines, helper text, labels, inactive tabs, future set numbers. 7.99:1 light, 7.97:1 dark.
- **Hairline** (`hair`): 1px row dividers inside boxes; disabled button fill. Dark: `hair-dark`. High contrast: `hair` becomes `ink`, so every rule is full ink.

### Named Rules
**The Derived Club Rule.** A club picks one color; the app computes `club-on`, the four `club-text-*` tones and the two `club-tint-*` washes from it. No club setting may produce a pairing below 4.5:1 (7:1 in high contrast), whatever color is supplied.

**The Highlighter Rule.** The club fill appears only on the club bar and the current set. Club color elsewhere is `club-text`: links, the club outline button, the active tab, the checked option, focus.

**The Fixed Fill Rule.** `club` and `club-on` do not change between modes. The bar and the current set look the same by day and night; only club-text and club-tint adapt to the paper.

**The Night Chart Rule.** Dark mode is the same chart with ink and paper swapped: same rules, same layout, same grid (in `grid-dark`). Never introduce surfaces, grays or elevation that the light chart lacks.

**The Full-Ink Contrast Rule.** High contrast removes the grid, draws every hairline in full ink, sets text at 7:1 or better, and thickens the focus ring to 4px. Nothing else moves.

**The Word-First Status Rule.** Every status color travels with a word and usually an icon ("Due Nov 15, in 8 days", a tick plus "All forms signed"). Color confirms; it never carries meaning alone.

## Typography

**Reading Font:** Atkinson Hyperlegible (with system-ui, sans-serif)
**Mark Font:** Barlow Condensed (with Arial Narrow, sans-serif)

**Character:** Atkinson is the plain, legible voice for everything a parent reads, chosen for older eyes and older phones. Barlow Condensed is the drill chart's lettering: set numbers, box headings, the club name, labels and navigation.

Both faces must be **self-hosted in the Next.js app** (for example via `next/font/local`) with the weights in use: Atkinson 400, 400 italic, 700; Barlow Condensed 500, 600, 700. The reference page loads Google Fonts only as a prototype.

### Hierarchy
Sizes are rem against a 16px root (18px Large, 20px Larger).
- **Display** (Atkinson 700, 2.5rem, line-height 1, -0.02em, tabular): the family's amount owed. One per screen.
- **Headline** (Barlow Condensed 700, 1.5rem, 1.1): box headings ("Ramirez family", "Your students").
- **Club name** (Barlow Condensed 700, 1.3125rem): the club's name in the bar.
- **Set number** (Barlow Condensed 700, 1.25rem): numbers in the season ruler.
- **Setting legend** (Barlow Condensed 700, 1.25rem, 1.2): the name of a choice group ("Appearance", "Text size").
- **Title** (Atkinson 700, 1.1875rem): a person's name in a list.
- **Body** (Atkinson 400, 1.0625rem, 1.45): default text, buttons (700), amounts, option names (700).
- **Body row** (1rem): invoice and history rows, detail values, secondary buttons. **Body small** (0.9375rem) and **Meta** (0.875rem): box subtitles, setting hints and option descriptions; dates, "as of", part and grade. Set labels are 0.8125rem on phones (0.9375rem at 760px+); nothing smaller.
- **Label** (Barlow Condensed 600, 0.9375rem, 0.06–0.08em, uppercase): the season heading and definition terms (Email, Phone, Address). Labels name real content beside them.
- **Nav / Tab** (Barlow Condensed 600, 1.125rem desktop nav, 0.9375rem phone tabs at 0.03em).

### Named Rules
**The Two-Hands Rule.** Atkinson for reading, Barlow for marking. A sentence is never set in Barlow; a set number is never set in Atkinson.

**The Ledger Figures Rule.** Every amount, count, phone number and date-with-digits uses tabular lining figures (`font-variant-numeric: tabular-nums lining-nums`).

**The Rem-Only Rule.** Every font size is in rem so the Text size setting and browser zoom scale all of it. Never set type in px.

## Layout

The page sits on a 24px chart grid (`cell`) drawn on the body background. The content column is max 1032px with 24px side padding; at 1032px+ the grid tile is offset so its lines meet the content's left edge. Box gaps are one cell (24px). On desktop the header stack is sized so boxes start on a grid row (bar 56 + season band 142 + 2px rule = 200; main padding 40 puts box tops at 240). Spacing inside boxes uses the 4/8/12/16/24/48 scale.

- **Phone (<760px):** single column of boxes; bottom tab bar fixed (64px tabs plus safe-area inset), body padded 88px so content clears it; Pay buttons go full width under their invoice row; choice options stack one per row.
- **760px and up:** tabs hide, top nav appears in the club bar; boxes form a two-column grid (money and students on top, paid history and details below); invoice rows become text | Pay (min 112px) | amount (min 96px); choice options sit in a row of `--cols` equal columns (3, or 2 for Motion).
- **Single-box pages** (Display): one box, max 760px wide, under a page head (back link, page title, one-line intro).
- **Larger text:** the layout reflows; nothing clips. Grid alignment of the desktop header is exact at the standard size only.

**The On-Grid Rule.** Page gutters, box gaps and the header stack resolve to multiples of 24px so boxes sit on the paper's lines.

## Elevation & Depth

Flat by conviction, in every mode. There is no elevation: depth comes from ink weight (2px structural rules versus 1px hairlines) and from the club fill. `box-shadow` appears only as an **inset rule**, a drawn line inside an element: the 3px underline on the current top-nav link, the 3px top rule on the active tab, the 2px ring on an unfinished student dot, the 1px inner rule that doubles a checked option's border. Dark mode adds no surfaces or layers.

**The Drawn-Not-Lifted Rule.** No drop shadows, blur, glow or offset shadows. If something needs emphasis, rule it heavier or fill it.

## Shapes

Square corners everywhere (0px): boxes, buttons, badges, set cells, choice options, the tab bar. The only round shapes are **people**, plus the radio mark: student dots on the ruler, the club monogram, the account initials, and the 20px radio circle inside a choice option (the platform's own convention for a single choice).

**The Dots-Are-People Rule.** A circle means a person. Containers, buttons, chips and badges are never round or pill-shaped. The radio mark is the one sanctioned exception, and it lives inside a square option.

## Components

### Club bar
The club's own header. 56px, `club` fill, `club-on` text: monogram (34px circle, inverted colors, Barlow 700 0.875rem), club name, and on desktop the top nav and the account control; desktop nav links are 44px tall. The club's logo replaces the monogram when supplied.
- **Account control:** a link (not a button) to Account / Display: 44px circle, 2px `club-on` outline, initials in Barlow 700. Its accessible name says where it goes ("Your account and display settings, Ana Ramirez"); `aria-current="page"` on the Display page.
- **Focus on the club fill:** inside the bar the focus ring switches to `club-on`, because `club-text` can vanish against the fill.

### Season set ruler (signature)
The club's season steps drawn as yard-line cells. Not a control.
- **Heading:** Label style, "Fall season · **Set 2 of 5**", current part in `ink`. On phones (<760px) the current set's name is always appended in the heading ("Set 2 of 5: Forms"), so a hidden cell label loses nothing; at 760px+ it is dropped from the heading.
- **Cells:** equal columns (`--count` = number of sets), 2px `ink` left rules with a closing right rule, min 60px tall; hash ticks along the foot (2px ink at 25% intervals, 45% opacity, 6px tall; full opacity in high contrast).
- **States:** done sets show a tick and number in `done` plus hidden ", done"; the current set (`aria-current="step"`) fills with `club`, its number, label and ticks in `club-on`, plus hidden ", current set"; future sets in `ink-2`.
- **Labels that don't fit:** each cell is a size container; under 76px wide (narrow phone, larger text, zoom) its label hides and the number stays. Labels clamp to two lines otherwise.
- **Students on set:** one 20px dot per student under the current set, initial in Barlow 700 0.75rem. Finished: `done` fill, paper initial. Still to do: paper fill, `due` 2px inset ring and initial. On the club-filled current set every dot gets a 2px `club-on` outline and the dots spread to an 8px gap, so each keeps an edge whatever the club color. Dots are decoration; the same facts are stated in words in the students box.
- **Many sets:** with more than 6 sets on a phone (<760px) every label hides and cells show numbers only. At 760px+ labels return.
- **Reuse:** staff screens use the same ruler as the column header of the forms matrix, one column per set.

### Boxes
The ruled container for every section: `paper`, 2px `ink` border, 0 radius, 16px padding, no shadow. Headline, then an optional `ink-2` body-small subtitle. Rows inside are divided by 1px `hair` rules.

### Money lines and total
- One row per open invoice: what ("Fall uniform fee, Maya"), a meta date line, and the amount right-aligned in tabular figures.
- **Urgency ramp, on the date line only:** due later `ink-2` ("Due Nov 22"); due soon `due` bold with the distance ("Due Nov 15, in 8 days"); past due `late` bold ("Was due Oct 30"). Amounts never change color. Paid rows show "Paid Aug 28" and a `done` "Paid" under the amount.
- **Total:** one amount column that sums to a 2px `ink` rule and a bold "Total". The big Display figure above equals the Total.
- **One Pay per invoice:** QuickBooks pays one invoice at a time. The soonest-due invoice gets the filled black Pay with an arrow; others get outlined Pay. Each Pay's accessible name states the amount and invoice.
- **As of:** the owed figure always carries its source and time ("Owed now. From QuickBooks, as of 2:14 pm.").
- **Paid up:** `done` tick plus "You're all paid up. Thank you!"
- **QuickBooks offline:** the last known figures stay on screen with a note under the as-of line in `due`, bold Meta size, `role="status"` ("We can't reach QuickBooks right now. These are the last figures we have, and paying will work again shortly."). Every Pay becomes disabled, keeps its place and says why in its accessible name ("Pay $85.00, unavailable while QuickBooks is offline").

### Buttons
- **Shape:** square (0px), 2px border, Atkinson 700.
- **Primary** (`ink` fill, paper text, 48px tall, body size): the one main action, chiefly the soonest Pay. Hover inverts to paper with ink text.
- **Line** (paper, ink border and text, 44px, body-row size): other Pay buttons and ordinary actions ("Update my details"). Hover fills ink.
- **Club** (paper, `club-text` border and text, 44px, body-row size): actions that belong to the club's season ("Sign Maya's forms"). Hover `club-tint`.
- **Disabled** (`aria-disabled`): `hair` fill and border, `ink-2` text, not-allowed cursor. In high contrast (where `hair` is full ink) it becomes paper fill with a dashed `ink` border and `ink-2` text, so disabled never reads as a filled primary.
- **Motion:** color only, 150ms ease-out; none under reduced motion.

### Choice group (ruled options)
A set of radio buttons drawn as ruled options; the Display page is built from them. Inherit it for any single-choice setting.
- **Group:** a `fieldset` with a Setting legend and an optional `ink-2` body-small hint; options in a grid with an 8px gap, stacked on phones, `--cols` columns at 760px+.
- **Option:** a label wrapping a visually hidden native radio and a square ruled tile: 2px `ink` border, `paper`, min 56px tall, 8px 16px padding; a 20px ring (2px `ink`) as the radio mark, the option name in Body 700, an optional Meta description in `ink-2`. Hover: `club-tint` wash.
- **Checked:** border and ring turn `club-text`, the border is doubled by a 1px inset rule, and a 10px `club-text` dot fills the ring.
- **Focus:** the mode's ring (`club-text`, 3px or 4px in high contrast) with a 2px offset around the tile.

### Display page
Account / Display, reached from the account control. One box of four choice groups, in order: **Appearance** (Match my device, Light, Dark), **Contrast** (Match my device, Standard, High contrast), **Text size** (Standard, Large, Larger, each option name previewed at its own size), **Motion** (Match my device, Reduce motion). "Match my device" is always first and is the default. Changes apply at once; a closing `ink-2` note says the choice is saved on this device only.

### State line
One vocabulary across the product: **to do, waiting, done, closed**. Each is an icon plus words in Atkinson 700 0.9375rem. Built so far: to do = `due` alert-circle plus "2 forms to sign"; done = `done` tick plus "All forms signed". Waiting and closed must follow the same icon-plus-words pattern; their icon and color are not yet drawn. Counts beside a person ("1 of 3 signed") are Barlow 600 1rem, `ink-2`, right-aligned.

### Details list
Two-column definition list: Label-style terms in `ink-2`, values in Body row.

### Navigation
- **Phone:** fixed bottom tab bar, 2px `ink` top rule, four 64px tabs (icon 24px over Barlow label). Active tab: `club-text` with a 3px inset top rule. Count badge: square, `due` fill, paper figure, labeled ("2 to sign").
- **Desktop (760px+):** tabs hide; links move into the club bar in Barlow 600 1.125rem, `club-on`, active marked by a 3px inset underline.

### Focus
`:focus-visible` everywhere: `club-text` outline, 3px (4px in high contrast), 2px offset; `club-on` inside the club bar. High contrast also thickens link underlines to 2px.

### Windows contrast themes (forced colors)
Under `forced-colors: active` the system palette wins; the build only keeps every state readable without its own colors:
- The page grid is dropped; the club bar gets a 2px `CanvasText` bottom rule; the monogram gets a 2px `CanvasText` ring.
- The current set fills with `Highlight`, its number, label and ticks in `HighlightText` (`forced-color-adjust: none`). Hash ticks on other sets are kept in `CanvasText` at full opacity.
- Student dots are drawn on `Canvas` with `CanvasText` initial and ring; finished dots invert (`CanvasText` fill, `Canvas` initial). On the current set their outline is `HighlightText`.
- The current top-nav link and active tab are underlined (3px) instead of relying on inset rules; the count badge gets a 1px `CanvasText` border.
- Choice options: ring on `Canvas` with a `CanvasText` border; checked = 3px `Highlight` border and a `Highlight` dot; focus = 3px dashed `CanvasText` outline, 4px offset. All other focus rings use `Highlight`.

### Not yet designed
Inputs and forms beyond radio choice groups, the entrance motion moment, the waiting and closed states, and the monogram fallback for a club without a logo (the build's monogram is a prototype).

### Copy patterns
The voice is PRODUCT.md's warm, plain neighbor, kind about money. On screen that means: state facts plainly ("Was due Oct 30", never "OVERDUE"); count what is left ("2 forms to sign"); name the person on the button ("Sign Maya's forms"); offer help with a person, not a penalty ("Need more time on the uniform fee? Ask the treasurer. They're happy to work something out."); thank people ("You're all paid up. Thank you!"); when a service is down, say what still works and when it will come back.

## Do's and Don'ts

### Do:
- **Do** derive `club-on`, the four `club-text-*` tones and both `club-tint-*` washes from the club's one color; check every pairing reaches 4.5:1, and 7:1 in high contrast.
- **Do** keep page gutters, box gaps and header heights on the 24px grid.
- **Do** draw structure with 2px `ink` rules and rows with 1px `hair` rules.
- **Do** set every amount in tabular figures, right-aligned in one column that sums to a 2px Total rule, with an "as of" time beside the owed figure.
- **Do** give each invoice its own Pay; fill only the soonest-due one.
- **Do** pair every status color with a word, and an icon where there is room.
- **Do** keep tap targets at 44px or more (48px for the primary button, 56px for choice options, 64px for tabs) and the focus ring `club-text` 3px (4px in high contrast) with a 2px offset on paper (`club-on` inside the club bar).
- **Do** reuse the season set ruler as the header of the staff forms matrix.
- **Do** build every new color from the mode tokens so all four modes and forced colors work without extra rules; check a new surface in light, dark, both high-contrast sets and a Windows contrast theme.
- **Do** set type in rem and let layouts reflow at 125% text.
- **Do** make "Match my device" the first and default choice of every display setting, and store display choices on the device.

### Don't:
- **Don't** use drop shadows, blur or offset shadows; inset rules only.
- **Don't** round containers, buttons, badges or chips; circles are for people (and the radio mark) only.
- **Don't** use the club fill beyond the club bar and the current set, or change it between modes.
- **Don't** color an amount red; past-due red goes on the date line only.
- **Don't** set sentences in Barlow Condensed or numbers on the chart in Atkinson.
- **Don't** put a small uppercase label above a heading as decoration; labels name content beside them.
- **Don't** load fonts from Google in the app; self-host them.
- **Don't** hide a Pay button when QuickBooks is offline; disable it in place and say why.
