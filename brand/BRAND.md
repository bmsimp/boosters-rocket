# Boosters Rocket — Brand Guide

Boosters Rocket is an open-source parent portal for booster clubs of any kind (band, sports, theater, robotics, PTOs). Parents see outstanding balances, pay them, sign up for volunteer shifts, and read announcements.

- Website: https://boostersrocket.com (marketing + docs)
- Future hosted version: https://boostersrocket.app
- Design canvas (source of the visuals): https://claude.ai/artifact/9KbwQWzYLSzUvnATzq9Z4s

Tokens live in `tokens.css` / `tokens.json`. Logo files live in `logos/`.

---

## 1. The single most important rule: the club leads

Boosters Rocket is **co-branded**. Inside a club's portal, the **club's** name, logo and accent color lead. Boosters Rocket appears only as a "Powered by" badge.

| Surface | Whose brand leads | Boosters Rocket shows up as |
|---|---|---|
| Portal app screens (nav, buttons, links, active states) | Club | One-color "Powered by" badge in the footer |
| Portal sign-in page | Club | Full-color "Powered by" badge under the sign-in card |
| Emails sent by the portal | Club | Full-color "Powered by" line in the footer |
| boostersrocket.com, GitHub repo, docs | Boosters Rocket | Full brand |

Implementation:
- App accent = `--app-accent`, which reads `--club-accent` (set per club). **Do not hard-code Boosters Rocket indigo or red into portal UI.** Indigo is only the default when a club hasn't set a color.
- Clubs **can** set: display name, logo, one accent color (+ contrast color for text on it).
- Clubs **cannot** change: status colors (paid / due / overdue / info), text and background neutrals, focus rings, or remove the "Powered by" badge.
- When a club picks an accent, compute/validate a text color on it with ≥ 4.5:1 contrast; fall back to white or near-black.

---

## 2. Logo

**Name:** Boosters Rocket (two words in prose). **Wordmark:** `boostersrocket`, all lowercase, set in Bricolage Grotesque 800 — "boosters" in indigo, "rocket" in red. Stacked lockup is uppercase `BOOSTERS / ROCKET`.

**Mark ("Afterburn"):** a rocket climbing up and to the right, leaving a smoke trail shaped like a checkmark (balance paid, shift filled). The trail runs hot → cool: flame red at the engine, ember, glow, then white.

All files in `logos/` have **text converted to outlines** (no fonts needed). Ready-made PNG/PDF/EPS/icons are in `exports/`.

| File (`logos/`) | Use |
|---|---|
| `mark-color.svg` | Default mark, ≥ 32 px |
| `mark-color-small.svg` | 16–32 px (3-puff trail) |
| `mark-color-dark-bg.svg` | On dark/near-black backgrounds (Night Sky disc) |
| `mark-mono-open-white.svg` / `-small-white` | White one-color mark for dark or colored backgrounds |
| `mark-mono-badge.svg` / `-small`, `mark-mono-open.svg` / `-small` | One-color, `currentColor` (inherits CSS `color`) |
| `app-icon.svg`, `app-icon-small.svg`, `favicon.svg` | Rounded-square icon; favicon drops the window |
| `lockup-horizontal-color.svg`, `-color-dark-bg.svg`, `-mono.svg` | Mark + wordmark (website header, README, GitHub) |
| `lockup-stacked-color.svg`, `-color-dark-bg.svg`, `-mono.svg` | Mark over "BOOSTERS / ROCKET" |
| `powered-by-color-light.svg`, `-color-dark.svg`, `-mono.svg` | Co-branding badge; readable at 20 px tall |

Also in `exports/`: `icons/` (16, 32, 48, 180, 192, 512, maskable 512, favicon.ico/svg) and `social/github-social-preview-1280x640.png`.

Rules:
- Clear space: half the mark's height on every side.
- Minimum size: badge mark 20 px, open mark 16 px, "Powered by" text 12 px.
- Under 32 px always use a `-small` variant.
- Don't recolor the full-color mark, stretch it, rotate it, add effects, or put it on busy photos.
- One-color versions are one solid ink — no gradients or tints.

---

## 3. Color

| Token | Hex | Role |
|---|---|---|
| Launch Indigo | `#1E1B4B` | Primary dark, text, mark disc |
| Night Sky | `#332F72` | Mark disc on dark backgrounds |
| Booster Flame | `#E8433A` | Accent fills and CTAs on Boosters Rocket surfaces. **White text on it.** |
| Flame Ink | `#B82D28` | Red text on light backgrounds |
| Flame Ink Large | `#CC3530` | "rocket" in the wordmark on light, large text only |
| Flame on Dark | `#F06A5F` | Red text / wordmark on dark |
| Ember | `#F49A92` | Fills only — never text |
| Glow | `#FBD8D4` | Soft backgrounds (e.g. balance card) — never text |
| Field | `#FAF6F3` | Warm off-white page background |

**Status colors are fixed** and always pair color + icon + word (never color alone):
Paid (green check), Due (amber clock), Overdue (red alert), Info (blue). See `tokens.css`. Booster Flame is a red-coral and must stay visibly distinct from Overdue red — never use Flame for errors and never use Overdue red as decoration.

Contrast: all text ≥ 4.5:1 (≥ 3:1 at 24 px+). Ember and Glow never carry text.

Dark mode tokens in `tokens.css` are a **proposal** and need review against real screens.

---

## 4. Type

- **Bricolage Grotesque** (Google Fonts, OFL) — display: 800 for headings, 600 for subheads. Marketing and brand surfaces; in the app, page titles at most.
- **Inter** (Google Fonts, OFL) — all UI and body text, 400/500/600.
- Scale (px): 12 · 13 · 14 · 16 · 20 · 24 · 32 · 40 · 56.
- Money is always `font-variant-numeric: tabular-nums`.

---

## 5. Shape, spacing, components

- 4 px spacing grid. Touch targets ≥ 44 px.
- Radius: controls 8 px, app cards 12 px, marketing panels 20 px, pills 999 px.
- Buttons: real `<button>`/`<a>`; one primary action per card. On marketing surfaces the money action ("Pay balance") is indigo and the volunteer action ("Sign up") is flame — calm for money, inviting for helping.
- Icons: outline/stroke style (e.g. Lucide), 2 px stroke, inherit text color. No emoji in UI.
- Cards: white surface, 1 px border, no heavy shadows in the app.

**Smoke-puff motif:** a row of circles filling hot → cool (flame → ember → glow → empty outline). Use for progress (volunteer hours), section dividers on marketing, empty states. Don't scatter it everywhere.

---

## 6. Voice

- Plain, warm, practical. Volunteers wrote this for volunteers.
- **Money copy is calm and never shaming.** "Your balance is $[X], due [date]." Not "You owe" / "Delinquent" / "Final notice". Overdue states state facts and offer a next step.
- Volunteer copy can be upbeat: "Grab a shift", "Thanks for pitching in!"
- Rocket puns: sparingly, on marketing only ("cleared for launch"). Never in error or payment messages.

---

## 7. Open items

- Dark-mode palette: review proposed tokens on real screens.
- Re-test Paid green next to Booster Flame in context.
- Brand-use policy for forks (suggested: code is open; name and logo reserved — forks rename).
- Trademark search on "Boosters Rocket"; secure the GitHub org name.
- Printable templates: QR "join the portal" flyer, email header, social post.
