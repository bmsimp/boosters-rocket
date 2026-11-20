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
  table-header:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
  notice:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px 16px"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
    height: "44px"
  field-disabled:
    backgroundColor: "{colors.hair}"
    textColor: "{colors.ink-2}"
  check:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.none}"
    size: "22px"
  check-checked:
    backgroundColor: "{colors.club-text}"
    textColor: "{colors.paper}"
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
| **Past-Due Red** (`late`): the date line of a past-due invoice, and the word and the icon cell of a problem notice (something that didn't go through) | `late` 7.37:1 | `late-dark` 7.83:1 | `late-hc` 10.35:1 | `late-dark-hc` 11.51:1 |

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

Both faces are **self-hosted by the Next.js app**: `next/font/google` in `src/app/layout.tsx` downloads them when the portal is built and serves them from the portal itself, so no page asks Google for a font. The weights in use: Atkinson 400 and 700; Barlow Condensed 500, 600, 700. The reference page loads Google Fonts only as a prototype.

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
The club's own header. 56px, `club` fill, `club-on` text: monogram (34px circle, inverted colors, Barlow 700 0.875rem, the club's short name), club name, and on desktop the top nav and the account control; desktop nav links are 44px tall. A club's logo is meant to replace the monogram; a club can't supply one yet (Not yet designed, below).
- **Account control:** a link (not a button) to Account / Display: 44px circle, 2px `club-on` outline, initials in Barlow 700. Its accessible name says where it goes ("AR: Your account and display settings, Ana Ramirez": it starts with the initials it shows, WCAG 2.5.3; the staff bar's reads "AR: Staff home, signed in as Ana Ramirez"); `aria-current="page"` on the Display page.
- **Focus on the club fill:** inside the bar the focus ring switches to `club-on`, because `club-text` can vanish against the fill.

### Season set ruler (signature)
The club's season steps drawn as yard-line cells. Not a control.
- **Heading:** Label style, "Fall season · **Set 2 of 5**", current part in `ink`. On phones (<760px) the current set's name is always appended in the heading ("Set 2 of 5: Forms"), so a hidden cell label loses nothing; at 760px+ it is dropped from the heading. On Home it is a labelled line (`p.season-title`), not a second page heading: Home's `h1` is the greeting. Beside it sits the way to the Season page ("See the whole season", `club-text` bold, 44px tall); it wraps under the heading when there is no room. When every set is done the heading says so ("All 5 sets done"). When the season asks nothing of the family in any set, nothing is done, because nothing was to do: the heading says "Nothing to do yet" and no set is ticked.
- **Cells:** equal columns (`--count` = number of sets), 2px `ink` left rules with a closing right rule, min 60px tall; hash ticks along the foot (2px ink at 25% intervals, 45% opacity, 6px tall; full opacity in high contrast).
- **States:** done sets show a tick and number in `done` plus hidden ", done"; the current set (`aria-current="step"`) fills with `club`, its number, label and ticks in `club-on`, plus hidden ", current set"; future sets in `ink-2`. The ruler reads left to right: only a set behind the current one is ticked, and one the family left unfinished there has no tick and hidden ", not finished". A set ahead is drawn as still to come, even when it asks nothing of the family.
- **Labels that don't fit:** each cell is a size container; under 76px wide (narrow phone, larger text, zoom) its label hides and the number stays. Labels clamp to two lines otherwise.
- **Students on set:** one 20px dot per student under the current set, initial in Barlow 700 0.75rem. Finished: `done` fill, paper initial. Still to do: paper fill, `due` 2px inset ring and initial. On the club-filled current set every dot gets a 2px `club-on` outline and the dots spread to an 8px gap, so each keeps an edge whatever the club color. Dots are decoration; the same facts are stated in words in the students box.
- **Many sets:** with more than 6 sets on a phone (<760px) every label hides and cells show numbers only. At 760px+ labels return.
- **Reuse:** the forms matrix is meant to take the same ruler as its column header, one column per set. Not built yet: the matrix has one column per form, under no set (`docs/ui-backlog.md`).

### Boxes
The ruled container for every section: `paper`, 2px `ink` border, 0 radius, 16px padding, no shadow. Headline, then an optional `ink-2` body-small subtitle. Rows inside are divided by 1px `hair` rules.

### Money lines and total
- One row per open invoice: what ("Fall uniform fee, Maya"), a meta date line, and the amount right-aligned in tabular figures.
- **Urgency ramp, on the date line only:** due later `ink-2` ("Due Nov 22"); due soon `due` bold with the distance ("Due Nov 15, in 8 days"); past due `late` bold ("Was due Oct 30"). Amounts never change color. Paid rows show "Paid Aug 28" and a `done` "Paid" under the amount. "Soon" and "past" are counted from the club's own date, in the club's time zone, for an invoice and for a season requirement alike, so every parent of a club reads the same words on the same day.
- **Total:** one amount column that sums to a 2px `ink` rule and a bold "Total". The big Display figure above equals the Total.
- **One Pay per invoice:** QuickBooks pays one invoice at a time. The soonest-due invoice gets the filled black Pay with an arrow; others get outlined Pay. Each Pay's accessible name states the amount and invoice.
- **As of:** the owed figure always carries its source and time ("Owed now. From QuickBooks, as of 2:14 pm.").
- **Paid up:** `done` tick plus "You're all paid up. Thank you!"
- **Figures that are not current:** when QuickBooks can't be read just now, the last known figures stay on screen with a note under the as-of line in `due`, bold Meta size, `role="status"` ("We couldn't get the latest figures from QuickBooks just now. These are the last ones we have. Paying here is paused until we can. Need to pay sooner? Ask the treasurer."). Every Pay becomes disabled, keeps its place and says why in its accessible name ("Pay $85.00, paused until the figures are up to date"). The note is the same whatever the cause, and the causes are not all an outage: QuickBooks may need connecting again by an Admin, or another read may be under way. So it never says QuickBooks is down, and never promises when paying will be back.
- **Payments not connected:** a family the portal can tell has no link to the club's books (from stage 3 of the app-owned families spec: a family staff added that waits to be linked, or a club with no accounting system) gets the money box with its heading ("What you owe") and one `help` line, `role="status"`: "The club hasn't connected your payments to the portal yet. Until then, the treasurer can tell you what you owe." No figure, no as-of line, no invoice, no Pay, no paid list, no not-current note and no "See your payments" button; it names no system and gives no reason. Everything else on the page is as usual. It shows only when the portal can tell (`notConnected` from `loadFamilyMoney()`); whenever it can't, or the family is linked but has nothing to show, the box keeps "We can't show what you owe right now. Please check back in a little while.", so a linked family never reads it in place of what it owes.

### Passkey offer (Home)
Right after a sign-in that proved a second step, Home shows one box after the greeting and before the family's boxes, across both columns at 760px and wider (no wider than 760px): headed with its question, a phone's ("Sign in with Face ID or your fingerprint next time?") or a computer's ("Sign in with a passkey next time?"), one sentence of what it does, a `help` line that it can be removed under Sign-in settings, then a primary **Turn on** beside a line **Not now** (wrapping under each other where there is no room; busy is "Turning on…", `aria-disabled`). Turned on, the box keeps its heading and says so in a `done` tick line that takes the focus, with the ten backup codes once for a first passkey with no app, drawn as on Sign-in settings. Not now replaces the box with its answer, a `done` tick line, `role="status"`, which takes the focus; the third answer is followed by a **Sign-in settings** link alone on its line. A refused or cancelled add is an alert under the buttons, and the box stays; refused because the ten minutes after signing in have passed (Home has no asking again), the alert says so and is followed by a **Sign-in settings** link alone on its line. The backup codes' keeping words name Sign-in settings, not "this page". Nothing is drawn until the page has read the browser, and nothing at all where the browser can't make a passkey or the page is at another address.

### Buttons
- **Shape:** square (0px), 2px border, Atkinson 700.
- **Primary** (`ink` fill, paper text, 48px tall, body size): the one main action, chiefly the soonest Pay. Hover inverts to paper with ink text.
- **Line** (paper, ink border and text, 44px, body-row size): other Pay buttons and ordinary actions ("Update my details"). Hover fills ink.
- **Club** (paper, `club-text` border and text, 44px, body-row size): actions that belong to the club's season ("Sign Maya's forms"). Hover `club-tint`.
- **Busy on a parent page** is `aria-disabled`, never `disabled`: a button that becomes disabled while it has the focus drops the focus to the page. The form refuses a second submit while its action runs.
- **Disabled** (`aria-disabled`, or the native `disabled` a form's button carries while its action runs): `hair` fill and border, `ink-2` text, not-allowed cursor, and no hover. In high contrast (where `hair` is full ink) it becomes paper fill with a dashed `ink` border and `ink-2` text, so disabled never reads as a filled primary. Under forced colors the border is dashed and the text `GrayText`.
- **Motion:** color only, 150ms ease-out; none under reduced motion.

### Choice group (ruled options)
A set of radio buttons drawn as ruled options; the Display page is built from them. Inherit it for any single-choice setting.
- **Group:** a `fieldset` with a Setting legend and an optional `ink-2` body-small hint; options in a grid with an 8px gap, stacked on phones, `--cols` columns at 760px+.
- **Option:** a label wrapping a visually hidden native radio and a square ruled tile: 2px `ink` border, `paper`, min 56px tall, 8px 16px padding; a 20px ring (2px `ink`) as the radio mark, the option name in Body 700, an optional Meta description in `ink-2`. Hover: `club-tint` wash.
- **Checked:** border and ring turn `club-text`, the border is doubled by a 1px inset rule, and a 10px `club-text` dot fills the ring.
- **Focus:** the mode's ring (`club-text`, 3px or 4px in high contrast) with a 2px offset around the tile.

### Tables
For content that is a table: rows of the same things with the same facts, such as the roster, Parents, Balances, the audit log, the forms matrix, a shift's sign-ups, a requirement's progress and the Reconciliation lists. One primitive (`DataTable`, `src/app/components/data-table.tsx`) serves them all. A list of a few things each with its own shape stays a list (`.lines`); money owed stays a ledger (Money lines and total).
- **Laptop (760px and up):** a real table inside its box. A caption says what it lists, drawn as an `ink-2` Body small line, or read out only (`captionHidden`) when the box's heading already says it. Header cells (`scope="col"`) are Label style in `ink-2` over a 2px `ink` rule; rows are divided by 1px `hair` rules; no zebra stripes, no fills. The cell that names a row is a header cell (`scope="row"`), bold. Numbers and amounts (`numeric`) are right-aligned in tabular figures. A column of buttons (`quiet`) has its header read out only and its buttons at the row's end.
- **Phone (below 760px):** the header row is hidden and each row stacks: a hairline above it, the row's name first and bold, then each cell as its column's label (Label style at 0.8125rem, `ink-2`) beside its value, two fifths and three fifths. Buttons sit under the row, at its start. The page never scrolls sideways.
- **Semantics kept:** CSS that changes how a table displays can take its table semantics away, so every part carries its role (`table`, `rowgroup`, `row`, `columnheader`, `rowheader`, `cell`). The label shown in a stacked cell is hidden from assistive technology, which reads the header already.
- **Groups:** rows can be grouped under a heading row (the forms matrix's families): a `rowgroup` whose first row is a `rowheader` across every column, Atkinson 700 over a 2px `ink` rule.
- **Wide tables:** a table with a column per item (the forms matrix) scrolls inside its own focusable region at laptop widths, its names column held in place, and stacks like any other on a phone.
- **Order:** rows come in the page's own order; no sort controls. The column the rows follow says so with `aria-sort` (the audit log, newest first).
- **A filtered list** (the forms matrix, Accounting links): a plain GET form above the table (`.matrix-filter`: three columns at 760px+, stacked below), with a `select` of fixed keys and a search field built from the Form controls, a Show button (`btn-line`) and, once anything is chosen, a 44px link back to the whole list. Accounting links' status choice says each status's count over the whole list ("Suggested (3)"; a carried-over family with differences counts under both Carried over and Linked, with differences, and a line under the form says so); the caption then says how many rows the filter shows of how many, and a Note says when none match. What the address carries is checked on the server: an unknown key or a list shows everything, and a search over its 100 characters is not run and says so in a needs-attention notice.
- **A row that opens:** a row whose facts don't fit its cells keeps them in its last column as a `details.more` (its summary at least 44px, named for the row: "Students and guardians: <family>", the name read out only), holding short lists. No script, nothing drawn but the primitives. A status cell is a State line (icon and words) with its reason under it as a `when` line.
- **Dark and high contrast:** tokens only; in high contrast every hairline is full ink. Under forced colors the rules are `CanvasText`.

### Notices
A status that is not part of a box's ordinary text: the QuickBooks and roster notices, a refresh's answer, the staff home's warnings, what a form's action answered, and any line that is really a state. One primitive (`Notice`, `src/app/components/notice.tsx`), four tones, each with its own word and icon, so color only repeats them:
| Tone | Word | Icon | Ink |
|---|---|---|---|
| information | Note | circled i | `ink` |
| needs attention | Needs attention | triangle with a bang | `due` |
| done | Done | tick | `done` |
| problem | Problem | circled cross | `late` |
- **Drawn:** a ruled panel like every box: `paper`, a 2px `ink` rule evenly all round, 12px 16px padding, square corners. No edge is heavier or colored: the tone is carried by what the notice says. First a 28px square icon cell filled with the tone's ink, its 20px icon drawn in `paper`; then the word in Label style in the tone's ink; then the text in Body row. The fill and the icon are the same pair of tokens as the tone's text on paper, so the icon reads at the tone's own contrast in every mode.
- **With a title:** a notice can be a section of its own (the staff home's QuickBooks, mail and sign-in warnings): a Headline-size heading names it, the word is read before the heading but not drawn, and its link or button sits under the text.
- **Announced:** a problem is an alert, every other tone a status; a notice that is simply part of a page as it loads is announced as neither.
- **Dark and high contrast:** tokens only. Under forced colors the fill is gone: the rules and the icon cell's 2px edge are `CanvasText`, and the word and icon carry the tone.
- **Inside a form:** a warning about what saving will do (a role written with patterns) is a needs-attention notice that is part of the page, announced as neither, held to 60ch.
- **Copy:** the same voice as every page: say what happened, what still works and who can help. A refusal says the same thing whatever the reason.

### Form controls
Every staff form is built from these, and parent forms take them up as they are next designed.
- **Text fields and text areas:** Label-style label above, a 2px `ink` box, `paper`, min 44px tall, 8px 12px padding. They fill their column and never run past their box, whatever is typed or however long an option is. A text area grows downward only.
- **Password fields:** a text field (`type="password"`), with the rule said in words above it in `help` and named by the field's `aria-describedby`, in "characters" and never as a promise about a person's count. Choosing a password asks for it twice ("Type it again"), each with `autocomplete="new-password"`, and offers no username. The answer is in words: what is wrong and what to do, or the set line with a tick (`paid-up`) followed by a `.link-line` onward.
- **Selects:** drawn like a text field, with the arrow drawn in `ink` at the right; the platform's own arrow under forced colors.
- **Single choice:** the Choice group (below). Native radio lists are not used on new forms.
- **Check boxes:** a 22px ruled square (2px `ink`, `paper`); checked fills with `club-text` and a `paper` tick. Hover on an unchecked one: `club-tint`. Each sits in a 44px-tall label row.
- **Radio marks outside a choice group** (`.checks` lists kept for long option lists): a 22px ruled circle; checked turns the ring `club-text` with a 10px `club-text` dot.
- **Fieldsets:** a group of check boxes is a `fieldset` with a Label-style `legend`; a choice group's legend is the Setting legend.
- **Focus:** the mode's ring, as everywhere.
- **Disabled:** `hair` fill and border, `ink-2` text, not-allowed cursor; dashed `ink` border on `paper` in high contrast; dashed with `GrayText` under forced colors. Never color alone: a disabled control is also not focusable or says why beside it.
- **Forced colors:** check boxes and radio marks draw themselves (`forced-color-adjust: none`) on `Canvas` with a `CanvasText` edge; checked fills with `Highlight` and a `HighlightText` tick.

### Settings view
A settings page shows what is set as a box per part: a Headline, a state line (done or to do, in words), a details list, and one button to that part's own step page (Set up, Change, or Open the steps). The view has no inputs, and every settings page starts with "Back to Settings" (club-text, bold, 44px). The Settings page lays these boxes in two columns at 760px+. The step pages use the staff pages' form controls, and every answer is a notice (`ActionOutcome`).

### Club bar preview
On the club step of setup and the Club change page, a 56px sample of the club bar in the chosen color, with the derived club-on text, so the derived-contrast rule can be seen before saving.

### Quiet button
`.btn-quiet`: no border or fill, club-text and underlined, 44px tall, for an action less important than the Save beside it (Turn off sign-in, Change name).

### Staff home
What needs doing today, for the staff member signed in. A "Today" box first: one line for each kind of thing waiting (changes waiting or stuck on their way to QuickBooks, forms due within a week or signed and not yet finished, shifts in the next week with places to fill), each a to-do state line with a count in words, one line of what it means in `ink-2`, and the link to the page that deals with it. Each line is read only for staff who hold that page's permission. With nothing waiting the box says so in one calm line, a done state ("Nothing needs doing today."). The warnings about the portal's own connections (QuickBooks, outgoing mail, sign-in certificates) follow as titled notices. To Admins alone, after them, "Sign-in resets this week": a titled information notice, one line for each parent's sign-in another Admin reset in the last 7 days ("<who> reset <name>'s sign-in <when>.", the name linking to the person's page, then a link to that reset in the audit log), never the reason, at most 50 of them, with a sentence linking every reset in the audit log when there were more, and one closing sentence saying to ask whoever did it about one you didn't expect; with none, it isn't drawn. Then the signed-in box with Sign out.

### Display page
Account / Display, reached from the account control. One box of four choice groups, in order: **Appearance** (Match my device, Light, Dark), **Contrast** (Match my device, Standard, High contrast), **Text size** (Standard, Large, Larger, each option name previewed at its own size), **Motion** (Match my device, Reduce motion). "Match my device" is always first and is the default. Changes apply at once; a closing `ink-2` note says the choice is saved on this device only.

### State line
One vocabulary across the product: **to do, waiting, done, closed**. Each is an icon plus words in Atkinson 700 0.9375rem. Built so far: to do = `due` alert-circle plus "2 forms to sign"; done = `done` tick plus "All forms signed"; and a third, waived = `ink-2` struck circle plus "Waived", for a requirement the club has let a family or student off (the reason is never shown to the family). Waiting and closed must follow the same icon-plus-words pattern; their icon and color are not yet drawn. Counts beside a person ("1 of 3 signed") are Barlow 600 1rem, `ink-2`, right-aligned.

### Details list
Two-column definition list (`.details`): Label-style terms in `ink-2`, values in Body row.

### Small primitives
The pieces every page is put together from, beside the components above. Each lives in `src/app/booster.css` or `src/app/components/`; use them rather than a new rule.
- **Page head:** the page's `h1` (`.page-title`, Barlow 700 2rem) and an optional one-line intro under it (`.lede`, `ink-2`, at most 60ch).
- **Hint** (`.hint`): an `ink-2` Body small line that explains the control or text above it. Never a state: a state is a Notice or a State line.
- **Link line** (`.link-line`): a link alone on its line, 44px tall, so it is a tap target like a button.
- **Box foot** (`.box-foot`): the buttons or links that close a box, below its content. **Row actions** (`.row-actions`): two or more buttons side by side, wrapping on a phone.
- **One button** (`.one-button`): a button that runs an action, with its answer under it; while it runs it is `aria-disabled` on a parent page.
- **Steps:** a numbered list of things to do outside the portal (`.steps-list`, at most 68ch), and the step names of a set-up page in a row with the current one marked (`.setup-progress`, `aria-current="step"`).
- **Table heading** (`h3.table-head`): the heading over one of several tables in one box.
- **Copy field** (`CopyField`, `.copy-row`): a read-only value with its Copy button, for what staff paste elsewhere (a command, an address).
- **Times and dates:** an instant through `LocalTime` (in the viewer's zone, with UTC on hover) and a calendar date through `CalendarDate`; an amount through `formatMoney()`. Never formatted by hand.
- **Visually hidden** (`.visually-hidden`): words a screen reader reads that the page doesn't draw, such as which invoice a Pay button pays.

### Navigation
- **Phone:** fixed bottom tab bar, 2px `ink` top rule, one 64px tab of equal width for each parent page that exists (icon 24px over Barlow label). Active tab: `club-text` with a 3px inset top rule. Count badge: square, `due` fill, paper figure, labeled ("2 to sign").
- **Desktop (760px+):** tabs hide; links move into the club bar in Barlow 600 1.125rem, `club-on`, active marked by a 3px inset underline.
- **Staff menu (grouped).** A staff member's menu is Home, then groups (Families: Roster, Parents, Accounting links; Season; Money), Settings as one entry, then Admin last; an entry shows only to those who may open its page, and a group only when it has one (`staffMenu()`, `src/app/staff/(app)/staff-menu.ts`). At 760px+ a group is a button drawn like a top-nav link (Barlow 600 1.125rem, club-on, a 12px caret that turns over when open). It opens on click or keyboard only, never on hover, as a disclosure (aria-expanded, aria-controls). Its links drop into a panel under the button, right-aligned to it, on the club fill with a 2px club-on border, links 48px tall, the current one marked by a 4px inset left rule. One group is open at a time. It closes on Escape (focus back to its button), on tabbing out, on choosing a link and on a press outside the menu. The group holding the current page carries the 3px inset underline and the accessible name "<Group>, current section". Below 760px the Menu button opens one panel listing Home, each group's links under its name (Barlow 600 0.9375rem uppercase, a 1px club-on rule above), and Settings; the panel scrolls within the screen. With six entries the staff bar is normally one 56px row; `.bar-rows` still lets it wrap. The parent bar is unchanged and never wraps: it is always 56px, which the season ruler's grid counts on.

### Focus
`:focus-visible` everywhere: `club-text` outline, 3px (4px in high contrast), 2px offset; `club-on` inside the club bar. High contrast also thickens link underlines to 2px.
- **Skip to the page:** the first Tab stop of every club bar that has links in it (parent and staff). Read out but not drawn until it has the focus; then a ruled `paper` button, `ink` text and 2px border, 44px tall, at the top of the bar in the page's flow (it covers nothing), with the bar's `club-on` ring. It lands past the bar and the Switch family line, where the next Tab goes on into the page.

### Windows contrast themes (forced colors)
Under `forced-colors: active` the system palette wins; the build only keeps every state readable without its own colors:
- The page grid is dropped; the club bar gets a 2px `CanvasText` bottom rule; the monogram gets a 2px `CanvasText` ring.
- The current set fills with `Highlight`, its number, label and ticks in `HighlightText` (`forced-color-adjust: none`). Hash ticks on other sets are kept in `CanvasText` at full opacity.
- Student dots are drawn on `Canvas` with `CanvasText` initial and ring; finished dots invert (`CanvasText` fill, `Canvas` initial). On the current set their outline is `HighlightText`.
- The current top-nav link and active tab are underlined (3px) instead of relying on inset rules; the count badge gets a 1px `CanvasText` border.
- Choice options: ring on `Canvas` with a `CanvasText` border; checked = 3px `Highlight` border and a `Highlight` dot; focus = 3px dashed `CanvasText` outline, 4px offset. All other focus rings use `Highlight`.

### Not yet designed
The entrance motion moment, the waiting and closed states, a club's own logo (there is no way to supply one yet: every club shows its monogram), and the monogram fallback for a club without a logo (the build's monogram is a prototype).

### Copy patterns
The voice is PRODUCT.md's warm, plain neighbor, kind about money. On screen that means: state facts plainly ("Was due Oct 30", never "OVERDUE"); count what is left ("2 forms to sign"); name the person on the button ("Sign Maya's forms"); offer help with a person, not a penalty ("Need more time on the uniform fee? Ask the treasurer. They're happy to work something out."); thank people ("You're all paid up. Thank you!"); when a service is down, say what still works and who can help, and say when it will come back only if the portal knows.

## Installed app

The portal can be put on a phone's home screen and then opens without browser chrome. It is one app for the whole portal: parents and staff install the same thing. Everything below is built from the club's settings on each request, so a club that changes its color or short name gets a new icon without a rebuild.

- **Icon:** a square of `club` with the club's short name in `club-on`, centered. The letters are set in the one font that ships with the renderer (Geist Regular, not a portal face: the icon is the only place it appears), sized to fill the middle 60% of the icon and no more, so Android's round and squircle crops never touch them. Sizes: 192 and 512 (each listed for any use and as maskable), 180 for iOS, 48 for the browser tab, where the letters run wider because nothing crops it. A short name the font can't draw (an emoji, a script outside Western European) gets the **plain mark** instead: the checked radio mark, a ring with a dot, in `club-on`. A club logo will replace the monogram at the same addresses.
- **Label under the icon:** the club's name when it is 12 characters or fewer, otherwise the club's short name. A home screen cuts a longer label off with an ellipsis.
- **Status bar and theme color:** the browser's theme color is `club`, so Android's status bar and the task switcher match the club bar. On iOS the status bar style is `default`: the system draws its own bar above the page in the device's light or dark, so the clock is readable over any club color.
- **Safe areas:** the viewport covers the whole screen (`viewport-fit=cover`), and the page keeps clear of notches and the home indicator with `env(safe-area-inset-*)`: the club bar adds the top inset above its 56px, the gutters are the larger of 24px and the side inset, the bottom tab bar adds the bottom and side insets, and the body's bottom padding is 88px plus the bottom inset (the inset alone at 760px and up). Insets are 0 in an ordinary browser tab, where nothing changes. Zoom is never disabled.
- **Offline page:** when a page can't be loaded, a single box on the chart grid: a no-connection icon, "You're offline", one sentence on what to do, and a full-width primary **Try again** that asks for the same address again. It is the same for every club and every person: system font, `paper` and `ink` only, light and dark by the device setting, no club color or name and no family data, because it is the one thing the device stores.
- **Install hint:** a box headed "Add the portal to your home screen" with a one-line reason. On Chromium it holds a line **Install** button once the browser has offered its prompt; on iPhone and iPad it lists the steps (Share, Add to Home Screen, Add), preceded by "open this page in Safari" inside another app's browser. On the Display page the box is permanent. Under the sign-in form it is an offer: it carries a line **Not now** button, stays dismissed on that device, and is left out when the browser has neither a prompt nor steps to give. It never appears inside the installed app.

## Do's and Don'ts

### Do:
- **Do** derive `club-on`, the four `club-text-*` tones and both `club-tint-*` washes from the club's one color; check every pairing reaches 4.5:1, and 7:1 in high contrast.
- **Do** keep page gutters, box gaps and header heights on the 24px grid.
- **Do** draw structure with 2px `ink` rules and rows with 1px `hair` rules.
- **Do** set every amount in tabular figures, right-aligned in one column that sums to a 2px Total rule, with an "as of" time beside the owed figure.
- **Do** give each invoice its own Pay; fill only the soonest-due one.
- **Do** pair every status color with a word, and an icon where there is room.
- **Do** keep tap targets at 44px or more (48px for the primary button, 56px for choice options, 64px for tabs) and the focus ring `club-text` 3px (4px in high contrast) with a 2px offset on paper (`club-on` inside the club bar).
- **Do** reuse the season set ruler as the header of the staff forms matrix (still to build: `docs/ui-backlog.md`).
- **Do** build a list of like things as a `DataTable`, a status as a `Notice`, and a form from the Form controls; never a bare paragraph for a state.
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
- **Don't** hide a Pay button when the figures are not current; disable it in place and say why.
- **Don't** promise when a service will be back unless the portal knows; say what still works and who can help.
