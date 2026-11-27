# UI and UX backlog

Interface problems still open. Add a find at the bottom of its section, with the date and the page. When one ships,
delete it in the same commit (git history keeps it). The look and the rules are `docs/agents/ui.md` and
`docs/agents/owner-taste.md`.

## Staff pages
- **A season's requirements are still lines** (2026-11-16, `/staff/seasons/[id]`): each step's requirements are a
  `.lines` list, not a table.
- **The forms matrix has one column per form, grouped by nothing** (2026-11-16, `/staff/forms`): grouping the forms
  under their season's steps needs the step indicator drawn as a table header.

## Club settings
- **A club can't supply its logo** (2026-11-16, `/staff/settings/club`): every club shows its monogram in the club bar
  and on the app icon.

## Parent pages
- **A shift's page is titled "Sign up for a shift"** (2026-11-16, `/volunteer/shifts/[id]`): naming the event would
  tell a screen reader more.
- **Documenso's signing frame has a button with no name** (2026-11-16, `/forms/[id]`): Documenso's own page; report it
  upstream.
- **The signing frame's Sign button can sit under the tab bar at 390 wide** (2026-11-16, `/forms/[id]`): to be seen on
  a real phone first (`docs/runbooks/before-the-first-family.md`, part 4, item 11); if so, a small change to the
  `.sign-frame` height.
