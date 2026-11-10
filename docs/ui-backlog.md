# UI and UX backlog

A running list of interface problems found while using the portal. A design pass after v1 works through it,
using the Dot Book design system (`DESIGN.md`). Add new finds at the bottom of the right section, with the date
and the page. Move an item to **Done** when it ships.

## Open

### Staff page (`/staff/people`)
- **The roles dropdown pushes the page around when it opens** (2026-11-09). It expands inline and shoves the
  rows below. It should open as an overlay, or use a clearer pattern such as a checklist that's always visible.
- **Save sits awkwardly beside the roles dropdown** (2026-11-09). It's tall, it's separate from the control it
  saves, and it's easy to miss that changes need saving.
- **The first Admin's name shows as their email** (2026-11-09). Setup creates the first Admin without a name.
  Ask for a name in setup Step 3, or let people edit their name.
- **Layout of each person's row** (2026-11-09). The name, email and status line, the roles control and the
  sign-in button don't line up. "Turn off sign-in" is a full-width button that looks as important as Save.

### Roles page (`/staff/roles`)
- **Role form fields run outside their box** (2026-11-09). The Name, Include and Exclude fields are wider than
  the box they sit in.
- **Editing roles means typing permission patterns** (2026-11-09). "Include" and "Exclude" take wildcard
  patterns such as `Settings.*`. A volunteer shouldn't need to know the permission names. Offer a checklist of
  permissions in plain words (for example "See the audit log", "Change club settings"), grouped by area.

### Before sign-in (`/sign-in`, `/staff/sign-in`)
- **Reported as not mobile-friendly** (2026-11-09). In a phone-size test (390 and 360 pixels wide) both pages fit
  with no sideways scroll, so the problem isn't known yet. Waiting on a screenshot from the owner's phone. The pages also
  have no club bar, so they look unlike the rest of the portal.

### Parent family chooser (`/choose-family`, parent pages)
- **Family names** (2026-11-10). The chooser and Switch family show `Family account <QBO id>` until the roster plan
  brings family names; the switch line is unstyled.

### Setup and Settings → Sign-in
- **The page may not update right after downloading a certificate** (2026-11-09). The certificate panel
  refreshes on a 1.5-second timer after the download starts, so on a slow server the thumbprint can lag until
  the next page load.
- **The certificate panel looks like there's still work to do after setup** (2026-11-10). Once a certificate is in
  use and Microsoft accepted it, the card still shows **Download certificate** and **Replace certificate** as big
  buttons, so admins wonder if they must upload it by hand. Show a clear "Done: Microsoft accepted this
  certificate" state, and tuck download/replace under a "Manage certificate" option.

## Done
- **Staff menu unreachable on phones** (2026-11-09, all staff pages). Below tablet width the top menu was hidden
  and nothing replaced it (parents have bottom tabs; staff had nothing). Staff pages now get a Menu button that opens
  the same links, closes on a choice or Escape, and is announced as expandable.
- **The roles dropdown was unreadable in dark mode** (2026-11-09, Staff page). Its background was hard-coded
  white, so the dark-mode light text vanished. It now uses the theme colors and has a keyboard focus outline.
