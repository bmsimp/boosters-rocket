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
- **A season's requirements are still lines** (2026-11-16, `/staff/seasons/[id]`). Each step's requirements on a
  season's page are a `.lines` list; the other lists named with it became tables on 2026-11-17 (Done, below).

### Club settings (found during the 2026-11-16 handoff pass)
- **A club can't supply its logo** (2026-11-16, `/staff/settings/club`). `PRODUCT.md` has each club supply a logo
  (the v1 spec says only "branding"); the Club settings take a name, a short name and a color, and every club shows
  its monogram (the short name in a circle) in the club bar and on the app icon. `DESIGN.md` lists the logo as not yet
  designed.

### Parent pages (found by the 2026-11-16 accessibility pass)
- **A shift's page is titled "Sign up for a shift"** (2026-11-16, `/volunteer/shifts/[id]`). That is what a screen
  reader hears on arriving; naming the event would say more. (A form's page is named for its form since 2026-11-17.)
- **Documenso's signing frame has a button with no name** (2026-11-16, `/forms/[id]`). It is Documenso's own page;
  report it upstream.
- **The signing frame's Sign button can sit under the tab bar at 390 wide** (2026-11-16, the walk, `/forms/[id]`).
  Documenso's own Sign button in its signature dialog is hidden by the parent tab bar until the frame is scrolled to
  the top of the screen. To be seen on a real phone first (`docs/runbooks/before-the-first-family.md`, part 4, item
  11); if so, a small change to the `.sign-frame` iframe's height.


## Done
- **Lists that are still lines** (2026-11-16; done 2026-11-17). A family's roster page (students, parents, portal
  sign-ins, changes waiting), a family's progress page (one table per step, a heading row for the family and each
  student) and a family's volunteer credit (what is asked, the credit, the removed credit) are tables with captions,
  and their empty lists and states are notices. A season's requirements are still lines (Open, above).
- **Some lone links on older staff pages are short** (2026-11-16; done 2026-11-17). The Health page's fix links, "Who
  has done it" on a season's and a requirement's page, and the set-up pages' step links and foot links are 44px
  (`.link-line`). `tests/e2e/staff-pages.spec.ts` now opens every staff page on disk and measures every link that
  stands alone on its line, or on a line of links, beside table links and summaries.
- **The clean-up preview won't scale** (2026-11-12; done 2026-11-17, `/staff/settings/parents/setup`, step 1). Each
  problem is a heading with its count over a table (the held addresses with the families they are under, the people,
  the families, the sign-ins that would end), folded behind "Show all" past ten rows; "None." is a done notice.
- **A form's page is titled "Form"** (2026-11-16; done 2026-11-17, `/forms/[id]`). The page's title is the form's own
  name, found within the session's family as the page finds it; "Form" for anything else.
- **No way past the club bar** (2026-11-16; done 2026-11-17, every page with a club bar that has links). "Skip to the
  page" is the bar's first Tab stop, drawn only while focused, and lands past the bar (and the Switch family line) on
  parent and staff pages alike. The sign-in pages' bar has nothing to Tab through, so it has none.
- **The walk's small finds** (2026-11-16, `docs/walkthrough.md`; done 2026-11-17 on `slice/finish`). A signed form's
  page says "Signed" once; a buy-out's invoice on Payments says it pays instead of volunteering; setup's "Save name and
  email" answers in a notice; Parents says, before sign-ins are on, that held addresses come up there once they are; a
  step's line says when a payment requirement has no product or service yet; and the signed-forms matrix has a "Not
  ready yet" state and filter, with no Remind for a family whose only outstanding forms have no template.
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
  warnings and every staff form's answer are notices: a word and an icon in the tone's ink, never color alone. On a
  family's page the disconnected notice is set apart from the heading and the boxes. Since the walk of 2026-11-16 a
  notice is ruled evenly all round in 2px ink and its tone is a filled icon cell with its word, not a heavy left rule
  (`DESIGN.md`, Notices); the roles page's patterns warning is a notice too.
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
