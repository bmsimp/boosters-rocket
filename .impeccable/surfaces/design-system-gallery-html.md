---
version: 1
slug: "design-system-gallery-html"
primary_target: "design/system/gallery.html"
related_targets: ["src/app/booster.css"]
---

# Booster Rocket visual system (v2)

Scope: the whole product's visual system: tokens, every class in `src/app/booster.css`, the React
primitives in `src/app/components/ui/`, the living gallery (staff page "Design system" and its static
twin `design/system/gallery.html`), and parent Home as the reference surface. Mode: Operate. It
replaces the Dot Book world recorded on `design/reference/parent-home.html`.

Audience and job: parents and guardians of every age, often on older phones, who need to see what
is left to do, pay and sign; club staff (treasurers, directors, volunteers) at laptops who scan the
roster, Balances and season tables. Constraints: WCAG 2.2 AA; the club's color, name and season
steps come from runtime settings and must hold with any club color; four display modes (light,
dark, high contrast for each), text size Large and Larger, reduced motion, and forced colors.

## Direction contract

THESIS: The calm standard. Booster Rocket reads like a quiet, well-organized product in the manner of Linear: structure comes from spacing, grouping and a strict type scale, not heavy rules, boxes or graph paper. It refuses both the Dot Book's ruled-chart costume and the generic gray-card-with-drop-shadow pile.

OWN-WORLD: Near-white ground, white surfaces with 1px hairline borders and 8px radius (6px controls, full circle only for avatars and status dots); no shadows except a faint one on menus and popovers. Inter everywhere, self-hosted, tabular figures for all numbers. Near-black ink, one gray for secondary text that still passes 4.5:1. The club's color is the accent only: primary buttons, the active nav item, focus rings, the small club logo tile; the top bar is a white surface. Status is a small ring/dot icon plus words in field green, amber, red, gray.

STORY: A parent opens Home and in seconds reads what is left to do, grouped as To do, Students and Payments lists, and pays or signs in one tap; a treasurer scans the roster or Balances table without hunting for anything.

FIRST VIEWPORT: Parent Home at 390x844: a 56px white top bar (club logo tile, club name, avatar), the family name as h1 with one meta line (season step, "as of" time), a small section label "To do" over one bordered list whose rows carry a status ring, title and meta line, amount when there is one, and a compact Pay or Sign button with a 44px tap area; then a Students list; then the total owed; a white bottom tab bar with a hairline top border. Staff at 1440: the same top bar, then the page title, filters and one DataTable, dense but readable.

FORM: The category standard, chosen by the owner over the rolled direction (Wayfinding), benchmarked on Linear for parent and staff screens. seed:41d931cca926f251

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Notes

- Humane translation of Linear: body text 1rem minimum on phones, never below 0.8125rem anywhere;
  tap targets 44px; WCAG 2.2 AA throughout. Parents are every age, on older phones, so Linear's
  13px density is staff-desktop only and even there text keeps to the floor above.
- Composition target: the chosen sketch `.impeccable/mocks/decision/canon.html` (the decision's
  canon) and the owner's preferred style A, column "A · Calm and dense" of the benchmarks sheet
  (`benchmarks.html` in the decision session's scratchpad): section labels over bordered lists,
  rows with a status ring, title, meta line, amount and a compact button.
- Kept from the Dot Book build: the runtime club color and its derived roles, word-plus-icon
  status, the season steps' markup and facts, every display mode.
