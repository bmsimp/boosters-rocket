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
  with no sideways scroll, so the problem isn't known yet. Waiting on a screenshot from the owner's phone. Both pages
  carry the club bar since 2026-11-15 (the club's name and monogram, no menu). The family chooser still has none.

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

### Mail (`/staff/settings/mail`, setup Step 2)
- **The page still needs a design pass** (2026-11-10). The numbered Microsoft 365 steps (see Done) sit above the
  settings form in one long box, the copy fields are plain, and nothing shows which step you are on or whether the
  script has been run. The staff home warning and this page should read as one guided task.

### Roster and QuickBooks (`/staff/roster`, `/staff/settings/quickbooks`)
- **Notices are bare paragraphs** (2026-11-11). "QuickBooks is disconnected, so this roster is no longer current",
  "Disconnected." and the Refresh now messages are plain text with no notice styling, so they are easy to miss. On a
  family's page the disconnected notice sits between the heading and the first box with nothing to set it apart.
- **Step 3 with no customer types is a dead end** (2026-11-11). A QuickBooks company with no customer types shows an
  empty choice. Say that the types are made in QuickBooks, and where.

### Settings as a whole (staff menu: Club, Sign-in, Mail)
- **Settings are separate pages with separate menu entries** (2026-11-10). The owner expects one **Settings** page
  with sections for staff sign-in and outgoing mail (and club details), not three top-level entries. Sections
  still have to follow permissions: Sign-in and Mail are Admin-only, Club has its own permission, so a person sees
  only the sections they hold. The owner's summary after the first proof-of-concept run with mail: the UI needs a
  lot of love.
- **QuickBooks is the first settings page in the new pattern** (2026-11-11). A plain view of what is set, with the steps
  on their own page. It has no styling of its own yet: the view is a list of labels and values, and the steps reuse the
  setup page's progress list. When Sign-in and Mail move to the same pattern, give all three one look.
- **Settings should be a static page with a wizard for setup or edit** (2026-11-10, parked by the owner). After the
  numbered steps went in, the owner said Mail "reads a bit better" but that it needs to become a page that shows
  the current settings plainly, with a step-by-step wizard opened to set a section up or change it. Applies to
  Sign-in and Mail alike, and fits the single Settings page above.
- **The staff script says "on the setup page" after setup is finished** (2026-11-10). Its last lines tell the Admin
  to enter values and use Send test email "on the setup page", but on a finished site that page is gone and the
  place is Mail. Say "in the portal" or name both.

### Parents and Parent sign-ins (`/staff/parents`, `/staff/settings/parents`)
- **No design of their own** (2026-11-12). Both pages, a person's page and the match review reuse the roster's
  list styles: labels and values, and lines of grey text under a name.
- **The To review items have no visual grouping** (2026-11-12, `/staff/parents`). Each item stacks the address,
  the names, the families, a note field and two buttons, with nothing to show where one item ends and the next
  begins, or that the note belongs to the buttons.
- **The clean-up preview won't scale** (2026-11-12, `/staff/settings/parents/setup`, step 1). It is a heading per
  problem and a comma-separated list of names under it. A real roster with dozens of names per heading needs lists
  that open, with counts in the headings.
- **The match review needs a table on wide screens** (2026-11-12, `/staff/settings/parents/matches`). The old
  family, the suggestion, the reason and the choice are stacked lines; side by side they would compare at a glance.
- **The staff menu has fourteen entries** (2026-11-12; fourteen since 2026-11-15). Home, Roster, Parents, Seasons,
  Progress, Staff, Roles, Club, Sign-in, Mail, QuickBooks, Parent sign-ins, Audit and Health, for an Admin. It needs
  grouping; this ties in with the single Settings page above. **Parents** and **Parent sign-ins** are also easy to
  mix up, and **Seasons** and **Progress** are two entries only because they have separate permissions.
- **Step 2 says sign-ins "made by hand" would end** (2026-11-12, `/staff/settings/parents/setup`, step 2). After
  sign-ins have been switched off and on again, the sign-ins that would end can come from QuickBooks too. Step 1
  was reworded to "QuickBooks no longer backs these"; step 2 should say the same.
- **Step 1 shows "Sign-ins that would end (0)" while sign-ins are on** (2026-11-12, same page). The list is only
  worked out while sign-ins are off, so when they are on the heading and its hint read oddly. Leave the heading out
  then.

## Done
- **The Mail page's instructions didn't look like instructions** (2026-11-10, Mail and setup Step 2). The owner
  followed "Outgoing mail needs attention" > **Open mail settings** and found a form; the step that has to come
  first (run the script so Microsoft 365 lets the portal send) was inside a collapsed section under the form, with
  the script inside a second collapsed section and `<tenant>` left to look up. The steps are now numbered and open
  above the form until mail works, with the club's tenant ID and the saved mailbox already in the command.
- **Staff menu unreachable on phones** (2026-11-09, all staff pages). Below tablet width the top menu was hidden
  and nothing replaced it (parents have bottom tabs; staff had nothing). Staff pages now get a Menu button that opens
  the same links, closes on a choice or Escape, and is announced as expandable.
- **The roles dropdown was unreadable in dark mode** (2026-11-09, Staff page). Its background was hard-coded
  white, so the dark-mode light text vanished. It now uses the theme colors and has a keyboard focus outline.
