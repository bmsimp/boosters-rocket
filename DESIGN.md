---
name: Booster Rocket
description: A white-label parent portal drawn like a marching-band dot book, so a family always knows its next set.
colors:
  club: "#5b2a86"
  club-on: "#ffffff"
  club-text: "#5b2a86"
  club-tint: "#f1ebf6"
  paper: "#ffffff"
  grid: "#e8eae6"
  ink: "#14161a"
  ink-2: "#4c5159"
  hair: "#d9dcd6"
  done: "#2f6b3a"
  due: "#9a4f08"
  late: "#a3261b"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "\"tnum\", \"lnum\""
  headline:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.005em"
  club-name:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.01em"
  set-number:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1
  title:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.45
  body:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.45
  body-row:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  set-label:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
  body-sm:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  meta:
    fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "0.08em"
  nav:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "18px"
    fontWeight: 600
  tab:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "15px"
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

The season is a drill, and a family always knows its next set. Every screen is a page from the dot book students carry: white chart paper ruled with a faint 24px coordinate grid, near-black 2px ink rules, square corners, and the club's own colour used the way a drill writer uses a highlighter, to mark where you are now. Nothing floats; everything is drawn onto the paper.

The system is white-label. Each club supplies one colour at runtime, and the app derives everything else from it (see Colors). The club leads; Booster Rocket is credited in the footer, never featured. The grid reads as plain graph paper, so a theatre or sports club fits as well as a marching band.

Density is calm and phone-first: one column of ruled boxes on phones, a two-column box grid at 760px and up. Money is set like a ledger, with tabular figures in one right-aligned column that visibly sums to its total. The reference build is `design/reference/parent-home.html`; every later surface, staff screens included, inherits from it.

**Key Characteristics:**
- Chart paper ground: white with a 24px grid in `grid`, gutters and gaps on that grid.
- 2px `ink` rules for structure, 1px `hair` rules for list rows, no shadows, no rounded containers.
- One runtime club colour, derived into four roles, used for the bar, the current set, and club actions.
- Two faces: Atkinson Hyperlegible for anything read, Barlow Condensed for marks, labels and numbers on the chart.
- Status is always a word plus an icon, never colour alone.

## Colors

A white-and-ink chart palette with one runtime club colour and three field-status colours.

### Primary (runtime, per club)
The frontmatter values are FZN's purple default. The page's gold demo (`#gold`) hand-sets the set for a light club colour: club `#f2c200`, club-on `#14161a`, club-text `#7a5c00`, club-tint `#fdf6d6`. **The app must derive these, not ask clubs for them:**
- **Club Fill** (`club`): the colour the club picked, unchanged. Fills the club bar, the current set cell and text selection.
- **On Club** (`club-on`): ink or text on the club fill. White if white reaches 4.5:1 against the fill, otherwise `ink`.
- **Club Text** (`club-text`): the club colour as text, link, outline button and focus ring on paper. The club colour itself if it reaches 4.5:1 on white; otherwise darken it (lower lightness, same hue) until it does. Gold `#f2c200` becomes `#7a5c00` (6.25:1).
- **Club Wash** (`club-tint`): a pale wash of the club colour on paper, for hover on club actions only. `club-text` must still reach 4.5:1 on it (purple 8.47:1, gold 5.76:1).

### Tertiary (status)
- **Field Green** (`done`): done, paid, signed, finished sets. 6.39:1 on paper.
- **Due Amber** (`due`): to do, due soon, a student still on the current set, the unread-count badge. 6.01:1.
- **Past-Due Red** (`late`): only the date line of a past-due invoice. 7.37:1.

### Neutral
- **Chart Paper** (`paper`): the ground of the page, boxes, the season band and tab bar.
- **Grid Line** (`grid`): the 24px coordinate grid behind the page. Decoration only.
- **Drill Ink** (`ink`): body text, 2px structural rules, the filled Pay button. 18.1:1.
- **Pencil** (`ink-2`): secondary text: meta lines, helper text, labels, inactive tabs, future set numbers. 7.99:1.
- **Hairline** (`hair`): 1px row dividers inside boxes; disabled button fill.

### Named Rules
**The Derived Club Rule.** A club picks one colour; the app computes `club-on`, `club-text` and `club-tint` from it. No club setting may produce a pairing below 4.5:1, whatever colour is supplied.

**The Highlighter Rule.** The club fill appears only on the club bar and the current set. Club colour elsewhere is `club-text`: links, the club outline button, the active tab, focus.

**The Word-First Status Rule.** Every status colour travels with a word and usually an icon ("Due Nov 15, in 8 days", a tick plus "All forms signed"). Colour confirms; it never carries meaning alone.

## Typography

**Reading Font:** Atkinson Hyperlegible (with system-ui, sans-serif)
**Mark Font:** Barlow Condensed (with Arial Narrow, sans-serif)

**Character:** Atkinson is the plain, legible voice for everything a parent reads, chosen for older eyes and older phones. Barlow Condensed is the drill chart's lettering: set numbers, box headings, the club name, labels and navigation.

Both faces must be **self-hosted in the Next.js app** (for example via `next/font/local`) with the weights in use: Atkinson 400, 400 italic, 700; Barlow Condensed 500, 600, 700. The reference page loads Google Fonts only as a prototype.

### Hierarchy
- **Display** (Atkinson 700, 40px, line-height 1, -0.02em, tabular): the family's amount owed. One per screen.
- **Headline** (Barlow Condensed 700, 24px, 1.1): box headings ("Ramirez family", "Your students").
- **Club name** (Barlow Condensed 700, 21px): the club's name in the bar.
- **Set number** (Barlow Condensed 700, 20px): numbers in the season ruler.
- **Title** (Atkinson 700, 19px): a person's name in a list.
- **Body** (Atkinson 400, 17px, 1.45): default text, buttons (700), amounts.
- **Body row** (16px): invoice and history rows, detail values, secondary buttons. **Body small** (15px) and **Meta** (14px): box subtitles and helper text; dates, "as of", part and grade. Set labels go to 13px on phones (15px at 760px+); nothing smaller.
- **Label** (Barlow Condensed 600, 15px, 0.06–0.08em, uppercase): the season heading and definition terms (Email, Phone, Address). Labels name real content beside them.
- **Nav / Tab** (Barlow Condensed 600, 18px desktop nav, 15px phone tabs at 0.03em).

### Named Rules
**The Two-Hands Rule.** Atkinson for reading, Barlow for marking. A sentence is never set in Barlow; a set number is never set in Atkinson.

**The Ledger Figures Rule.** Every amount, count, phone number and date-with-digits uses tabular lining figures (`font-variant-numeric: tabular-nums lining-nums`).

## Layout

The page sits on a 24px chart grid (`cell`) drawn on the body background. The content column is max 1032px with 24px side padding; at 1032px+ the grid tile is offset so its lines meet the content's left edge. Box gaps are one cell (24px). On desktop the header stack is sized so boxes start on a grid row (bar 56 + season band 142 + 2px rule = 200; main padding 40 puts box tops at 240). Spacing inside boxes uses the 4/8/12/16/24/48 scale.

- **Phone (<760px):** single column of boxes; bottom tab bar fixed (64px tabs plus safe-area inset), body padded 88px so content clears it; Pay buttons go full width under their invoice row.
- **760px and up:** tabs hide, top nav appears in the club bar; boxes form a two-column grid (money and students on top, paid history and details below); invoice rows become text | Pay (min 112px) | amount (min 96px).

**The On-Grid Rule.** Page gutters, box gaps and the header stack resolve to multiples of 24px so boxes sit on the paper's lines.

## Elevation & Depth

Flat by conviction. There is no elevation: depth comes from ink weight (2px structural rules versus 1px hairlines) and from the club fill. `box-shadow` appears only as an **inset rule**, a drawn line inside an element: the 3px underline on the current top-nav link, the 3px top rule on the active tab, the 2px ring on an unfinished student dot.

**The Drawn-Not-Lifted Rule.** No drop shadows, blur, glow or offset shadows. If something needs emphasis, rule it heavier or fill it.

## Shapes

Square corners everywhere (0px): boxes, buttons, badges, set cells, the tab bar. The only round shapes are **people**: student dots on the ruler, the club monogram, and the account initials. That is the dot book's own mark, a dot is a performer, and it is reserved for them.

**The Dots-Are-People Rule.** A circle means a person. Containers, buttons, chips and badges are never round or pill-shaped.

## Components

### Club bar
The club's own header. 56px, `club` fill, `club-on` text: monogram (34px circle, inverted colours, Barlow 700 14px), club name, and on desktop the top nav and the account button (44px circle, 2px outline, initials); desktop nav links are 44px tall. The club's logo replaces the monogram when supplied.

### Season set ruler (signature)
The club's season steps drawn as yard-line cells. Not a control.
- **Heading:** Label style, "Fall season · **Set 2 of 5**", current part in `ink`.
- **Cells:** equal columns (`--count` = number of sets), 2px `ink` left rules with a closing right rule, min 60px tall; hash ticks along the foot (2px ink at 25% intervals, 45% opacity, 6px tall).
- **States:** done sets show a tick and number in `done` plus hidden ", done"; the current set (`aria-current="step"`) fills with `club`, its number, label and ticks in `club-on`, plus hidden ", current set"; future sets in `ink-2`.
- **Students on set:** one 20px dot per student under the current set, initial in Barlow 700 12px. Finished: `done` fill, paper initial. Still to do: paper fill, `due` 2px inset ring and initial. Dots are decoration; the same facts are stated in words in the students box.
- **Many sets:** with more than 6 sets on a phone (<760px) the labels hide, cells show numbers only, and the current set's name joins the heading ("Set 4 of 8: Tech week"). At 760px+ labels return.
- **Reuse:** staff screens use the same ruler as the column header of the forms matrix, one column per set.

### Boxes
The ruled container for every section: `paper`, 2px `ink` border, 0 radius, 16px padding, no shadow. Headline, then an optional `ink-2` 15px subtitle. Rows inside are divided by 1px `hair` rules.

### Money lines and total
- One row per open invoice: what ("Fall uniform fee, Maya"), a meta date line, and the amount right-aligned in tabular figures.
- **Urgency ramp, on the date line only:** due later `ink-2` ("Due Nov 22"); due soon `due` bold with the distance ("Due Nov 15, in 8 days"); past due `late` bold ("Was due Oct 30"). Amounts never change colour. Paid rows show "Paid Aug 28" and a `done` "Paid" under the amount.
- **Total:** one amount column that sums to a 2px `ink` rule and a bold "Total". The big Display figure above equals the Total.
- **One Pay per invoice:** QuickBooks pays one invoice at a time. The soonest-due invoice gets the filled black Pay with an arrow; others get outlined Pay. Each Pay's accessible name states the amount and invoice.
- **As of:** the owed figure always carries its source and time ("Owed now. From QuickBooks, as of 2:14 pm.").
- **Paid up:** `done` tick plus "You're all paid up. Thank you!"

### Buttons
- **Shape:** square (0px), 2px border, Atkinson 700.
- **Primary** (`ink` fill, paper text, 48px tall, 17px): the one main action, chiefly the soonest Pay. Hover inverts to paper with ink text.
- **Line** (paper, ink border and text, 44px, 16px): other Pay buttons and ordinary actions ("Update my details"). Hover fills ink.
- **Club** (paper, `club-text` border and text, 44px, 16px): actions that belong to the club's season ("Sign Maya's forms"). Hover `club-tint`.
- **Disabled** (`aria-disabled`): `hair` fill and border, `ink-2` text, not-allowed cursor.
- **Motion:** colour only, 150ms ease-out; none under `prefers-reduced-motion`.

### State line
One vocabulary across the product: **to do, waiting, done, closed**. Each is an icon plus words in Atkinson 700 15px. Built so far: to do = `due` alert-circle plus "2 forms to sign"; done = `done` tick plus "All forms signed". Waiting and closed must follow the same icon-plus-words pattern; their icon and colour are not yet drawn. Counts beside a person ("1 of 3 signed") are Barlow 600 16px, `ink-2`, right-aligned.

### Details list
Two-column definition list: Label-style terms in `ink-2`, values in Body 16px.

### Navigation
- **Phone:** fixed bottom tab bar, 2px `ink` top rule, four 64px tabs (icon 24px over Barlow label). Active tab: `club-text` with a 3px inset top rule. Count badge: square, `due` fill, paper figure, labelled ("2 to sign").
- **Desktop (760px+):** tabs hide; links move into the club bar in Barlow 600 18px, `club-on`, active marked by a 3px inset underline.
- **Focus on the club fill:** inside the club bar the focus ring switches to `club-on`, because `club-text` can vanish against the fill (1:1 on FZN purple).

### Not yet designed
Inputs and forms (no field exists in the reference build), the entrance motion moment, dark mode, and the monogram fallback for a club without a logo (the build's monogram is a prototype).

### Copy patterns
The voice is PRODUCT.md's warm, plain neighbour, kind about money. On screen that means: state facts plainly ("Was due Oct 30", never "OVERDUE"); count what is left ("2 forms to sign"); name the person on the button ("Sign Maya's forms"); offer help with a person, not a penalty ("Need more time on the uniform fee? Ask the treasurer. They're happy to work something out."); thank people ("You're all paid up. Thank you!").

## Do's and Don'ts

### Do:
- **Do** derive `club-on`, `club-text` and `club-tint` from the club's one colour and check every pairing reaches 4.5:1.
- **Do** keep page gutters, box gaps and header heights on the 24px grid.
- **Do** draw structure with 2px `ink` rules and rows with 1px `hair` rules.
- **Do** set every amount in tabular figures, right-aligned in one column that sums to a 2px Total rule, with an "as of" time beside the owed figure.
- **Do** give each invoice its own Pay; fill only the soonest-due one.
- **Do** pair every status colour with a word, and an icon where there is room.
- **Do** keep tap targets at 44px or more (48px for the primary button, 64px for tabs) and the focus ring 3px `club-text` with a 2px offset on paper (`club-on` inside the club bar).
- **Do** reuse the season set ruler as the header of the staff forms matrix.

### Don't:
- **Don't** use drop shadows, blur or offset shadows; inset rules only.
- **Don't** round containers, buttons, badges or chips; circles are for people only.
- **Don't** use the club fill beyond the club bar and the current set.
- **Don't** colour an amount red; past-due red goes on the date line only.
- **Don't** set sentences in Barlow Condensed or numbers on the chart in Atkinson.
- **Don't** put a small uppercase label above a heading as decoration; labels name content beside them.
- **Don't** load fonts from Google in the app; self-host them.
