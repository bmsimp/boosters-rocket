---
version: 1
slug: "design-reference-parent-home-html"
primary_target: "design/reference/parent-home.html"
related_targets: []
---

# Parent home (phone)

Scope: the screen a parent or guardian lands on after signing in. Mode: Operate. This is the
reference surface for Booster Rocket's visual world; staff screens and every later surface inherit
from it.

Audience and job: a non-technical parent on a phone, often outdoors or in a car, checking what
their family owes, paying, and signing this season's forms for each student. Success: they finish
without help. Constraints: WCAG 2.2 AA; the club's logo, name, color and season step names come
from runtime settings, so the screen must hold with any club color and any club type (band,
theater, sports), not only marching band.

Must not feel like: a school district website, something childish or cartoony, or a generic SaaS
dashboard.

## Direction contract

THESIS: The season is a drill, and a family always knows its next set. It refuses the category
default of stacked rounded cards (balance, forms, students) on a gray ground.

OWN-WORLD: White chart paper with a faint 24px coordinate grid. Near-black ink rules at 2px; square
corners; no shadows, no pills, no rounded cards. The club color fills the top bar and marks the
current set; field green marks done; amber marks due soon. Atkinson Hyperlegible for everything
people read; Barlow Condensed for set numbers, section labels and coordinates. Every amount in
tabular figures, right-aligned, and the family total is visibly the sum of its lines.

STORY: A parent opens the portal from a reminder, sees at once which set the season is on, what the
family still owes and what is still to sign, pays an invoice on QuickBooks' page in one tap,
and signs Maya's forms without asking anyone.

FIRST VIEWPORT: At 390×844: club bar (56px: logo, club name, account). Set ruler below it: "Fall
season · Set 2 of 5" over ruled yard-line cells with hash ticks, the current set filled in club
color, finished sets ticked in green; under it, one marker per student showing where they stand on
the current set ("Leo is done", "Maya has 2 forms left"). Ruled family box: "Ramirez family",
$185.00 at about 40px with "as of" time, then one row per open invoice with its own Pay button
(QuickBooks pays one invoice at a time; the soonest-due is the filled black button), and a 2px
Total rule that sums them. Ruled students box: name, part and grade, "1 of 3 signed", next step in
amber or green, and a full-width Sign button. Bottom tab bar: Home, Forms, Payments, Family.

FORM: Dot Book (marching drill charts and the dot books students carry), position 1 on the ordered
list, taken as Impeccable's pick over the assigned direction. seed:2abe8dd16d83b4fe. Signature
move: the season set ruler, the club's seasonal steps drawn as yard-line cells with the current
set filled, reused on staff screens as the column header of the forms matrix.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Notes

- Set names and count are per-club settings (for example "Join, Forms, Uniforms, Trip, Banquet"
  for FZN), so a theater or sports club gets its own steps; the grid reads as plain graph paper.
- Disciplines kept from declined challengers: one state vocabulary (to do, waiting, done, closed)
  drawn the same everywhere; totals that visibly add up.
- Unresolved: club logo handling when a club has none (monogram fallback), and dark mode.
