# UI and UX backlog

A running list of interface problems found while using the portal. A design pass after v1 works through it,
using the Dot Book design system (`DESIGN.md`). Add new finds at the bottom of the right section, with the date
and the page. Move an item to **Done** when it ships, with the date; strike one that no longer applies, with why.

The step 6 design pass split the list three ways: the staff pages, the settings, roles, staff and setup pages, and
accessibility across the portal. All three were merged on 2026-11-16; what they left open is below.

## Open

### Staff pages (found during the 2026-11-16 pass, not part of it)
- **The forms matrix doesn't use the season ruler as its header** (2026-11-16, `/staff/forms`). `DESIGN.md` says the
  matrix reuses the set ruler, one column per set; it has one column per form, grouped by nothing. Grouping the forms
  under their sets needs the ruler drawn as a table header, which is its own piece of design.
- **Lists that are still lines** (2026-11-16). A family's roster page (students, parents, portal sign-ins), a family's
  progress page, a family's volunteer credit and a season's requirements are still `.lines` lists. Each is short and
  has a shape of its own, so they were left as lists; if they grow, they take the table primitive like the others.

### Settings and Parent sign-ins (step 6 settings slice, still open)
- **The clean-up preview won't scale** (2026-11-12, `/staff/settings/parents/setup`, step 1). It is a heading per
  problem and a comma-separated list of names under it. A real roster with dozens of names per heading needs lists
  that open, with counts in the headings. Not done in step 6: the settings slice gave the page its back link, its
  wording and notices, not new lists.

### Parent pages (found by the 2026-11-16 accessibility pass)
- **A form's page is titled "Form" and a shift's "Sign up for a shift"** (2026-11-16, `/forms/[id]`,
  `/volunteer/shifts/[id]`). That is what a screen reader hears on arriving; naming the form or the event would say
  more.
- **No way past the club bar** (2026-11-16, every parent page). A keyboard user Tabs through six bar stops on every
  page; a "Skip to the page" link or focusing the heading on arrival would save them.
- **Documenso's signing frame has a button with no name** (2026-11-16, `/forms/[id]`). It is Documenso's own page;
  report it upstream.


## Done
- **Settings are one page** (2026-11-16, was Settings as a whole: separate pages and menu entries). `/staff/settings`
  has a section for each part (club, staff sign-in, outgoing mail, QuickBooks, parent sign-ins, forms), each shown
  only with its permission. Each says what is set and whether it works, in words with an icon, and opens its own page.
- **Every settings page is a plain view, with the steps on their own page** (2026-11-16; was "QuickBooks is the first
  settings page in the new pattern" and "Settings should be a static page with a wizard", parked). Club, staff
  sign-in, mail and forms now follow the QuickBooks page (club/edit, sign-in/setup, mail/setup, forms/setup), with a
  state line on each and a way back to Settings. Their answers and states are notices, like the other staff pages.
- **Parent sign-ins: no design of their own** (2026-11-12; done 2026-11-16). The view is a settings box with its
  state line, the steps' states are notices, and the match review is a table (below).
- **The staff script says "on the setup page" after setup is finished** (2026-11-16). It now says "in the portal: on
  the setup page, or under Settings, Staff sign-in" (or Outgoing mail).
- **The roles dropdown pushes the page around**, **Save sits awkwardly beside the roles dropdown**, **Layout of each
  person's row** (2026-11-16, Staff page). The roles are tick boxes that are always open, with their own Save roles
  button. The row lines up as name / roles / sign-in on wide screens. "Turn off sign-in" is a quiet link-styled
  button.
- **The first Admin's name shows as their email** (2026-11-16). Setup asks for the first Admin's name with their
  email, and anyone's name can be changed on the Staff page (by an Admin) or by the person themselves, on the staff
  home.
- **Editing roles means typing permission patterns**, **Role form fields run outside their box** (2026-11-16, Roles
  page). Roles are edited by ticking permissions in plain words, grouped by area. There are no pattern fields left. A
  role written with patterns shows what it gives today, and saving it says it will then no longer take up new
  permissions by itself. Roles can be deleted after a step that says how many hold them.
- **The page may not update right after downloading a certificate** and **The certificate panel looks like there's
  still work to do after setup** (2026-11-16). The page refreshes once the download has finished. A certificate in
  use reads "Done: Microsoft accepted this certificate", with Download and Replace under Manage certificate.
- **The Mail page still needs a design pass** (2026-11-16). Mail is one guided task on the setup page and under
  Settings alike: a list of the steps saying which are done, then each step in its own box. The staff home warning
  opens those steps.
- **Step 3 with no customer types is a dead end** (2026-11-16, QuickBooks setup). It says the types are made in
  QuickBooks, not in the portal: the gear menu, All lists, Customer types, then each customer's type, then Refresh
  now.
- **Step 2 says sign-ins "made by hand" would end** and **Step 1 shows "Sign-ins that would end (0)" while sign-ins
  are on** (2026-11-16, Parent sign-ins steps). Step 2 says "that QuickBooks no longer backs", and step 1 leaves the
  heading out while sign-ins are on.
- **The match review needs a table on wide screens** (2026-11-16). On 760px and up it is a table (family in the
  previous company, could sign in, suggestion, your choice), stacked on a phone: the table primitive.
- **The staff menu has fourteen entries** (2026-11-16). It is grouped: Home, Families (Roster, Parents), Season
  (Seasons, Progress, Signed forms, Volunteering, Volunteer credit), Money (Balances, Reconciliation), Settings as one
  entry, Admin (Staff, Roles, Audit, Health). Parent sign-ins is a part of Settings, no longer beside Parents. Seasons
  and Progress stay two entries, side by side in Season.
- **Parent pages checked for accessibility** (2026-11-16): label in name on the account link (parent and staff), 44px
  lone links, focus kept and statuses announced after volunteer, forms, sign-in, details and email actions, nothing
  left under the tab bar; `tests/e2e/parent-a11y.spec.ts` guards them.
- ~~**Before sign-in reported as not mobile-friendly**~~ (2026-11-09; struck 2026-11-16). `tests/e2e/parent-a11y.spec.ts`
  opens both sign-in steps at 360 and 1440 in every display mode and finds no sideways scroll, clipped text or small
  target. Reopen it with a screenshot from the phone that showed it.
- **Family names in the chooser** (2026-11-10; done since step 3's roster). The chooser and Switch family show each
  family's name from the roster cache; `Family account <id>` is only the fallback for a family the cache doesn't hold.
- **The staff side needs a lot of love** (2026-11-10, the owner; done 2026-11-16, every staff page outside Settings,
  Roles, Staff and setup). The staff pages are drawn from the design system's primitives: tables for lists of like
  things, notices for states, and the form controls (`DESIGN.md`: Tables, Notices, Form controls, Staff home).
- **The staff home was a welcome and a list of warnings** (2026-11-16, `/staff`). It now says what needs doing today,
  each item to those who hold its permission, as a count in words with a link: addresses to review, changes waiting
  or stuck on their way to QuickBooks, forms due within a week or signed and not yet finished, and shifts in the next
  week with places to fill. Nothing waiting reads as one calm line. The QuickBooks, mail and sign-in warnings are
  titled notices.
- **Notices are bare paragraphs** (2026-11-11, `/staff/roster`, a family's page; done 2026-11-16). "QuickBooks is
  disconnected, so this roster is no longer current", a failed refresh, the Refresh now messages, the staff home's
  warnings and every staff form's answer are notices: a word and an icon in the tone's ink, a heavy left rule, never
  color alone. On a family's page the disconnected notice is set apart from the heading and the boxes.
- **Lists of many things read as lines of grey text** (2026-11-16). The roster, Parents, Balances and Worth a look,
  the audit log, the signed forms matrix and its form list, a signed form's files, signers and consents, a shift's
  sign-ups, Volunteering's events, volunteer credit, Seasons, Progress and a requirement's list of who has done it,
  and the Reconciliation lists are tables at laptop widths, stacked with their labels on a phone, read as tables by a
  screen reader either way.
- **Staff forms used the browser's own controls** (2026-11-16). Selects draw their own arrow, check boxes and radio
  marks are ruled, single choices (who a requirement is asked of, required or optional, shifts or hours, who must sign
  a form, why a form starts again) are choice groups, a busy button looks disabled, and text fields stop at their box.
- **Parents: no design of its own** (2026-11-12, `/staff/parents` and a person's page; done 2026-11-16). People are a
  table; a person's page says first whether they can sign in, and each family's sign-in is a state line.
- **The To review items have no visual grouping** (2026-11-12, `/staff/parents`; done 2026-11-16). Each address is one
  block between heavy rules: the address, the names on the records and each family with its state, then the note
  and the two answers ruled in together as one decision.
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
