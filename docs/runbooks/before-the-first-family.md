# Before the first family: the checks only a person can make

Everything the portal can check by itself is checked by its tests. What is left needs a person: a real phone, a real
QuickBooks company, a real Documenso, a lawyer, Intuit. This runbook gathers all of it in the order you would do it,
from the first push to the day the welcome emails go out. Each item is one thing to do, what you should see when it
works (**Pass**), and what to do when it doesn't (**If not**). Write the date and what you saw in the
[Results](#results) table at the end; a "no" is as useful as a "yes".

Words in `<angle brackets>` are yours to fill in. Anything in `monospace` is typed exactly. "Settings, QuickBooks"
means: open **Settings** in the staff menu, then the **QuickBooks** box on that page. Where a screen no longer matches
what is written here, trust the screen and note it.

The other runbooks: [a first installation](first-install.md), [Intuit](intuit.md), [outgoing mail](mail.md),
[Documenso](documenso.md), [backups](backups.md), [updates](updates.md), [restore](restore.md),
[reconnecting QuickBooks](quickbooks-reconnect.md), [Health page warnings](health-warnings.md), and the record of the
proof of concept, [its own runbook](poc-linuxdev.md).

## 1. Push, and deploy to the proof-of-concept host

Nothing has been pushed yet. Until it is, CI has never run on GitHub, no image has been published, and the newest work
is on no server. The proof-of-concept host is the server its own runbook describes; it runs the portal with an Intuit
sandbox company and the club's Microsoft 365 mail, but no Documenso.

1. **Push the branch `parent-portal` and open a pull request into `main`.** CI runs on a pull request.
   **Pass:** both jobs, `test` and `image`, finish green, and the `test` job's "Unit and integration tests" step ends
   with a summary that counts every test file as passed (`Test Files  <n> passed (<n>)`).
   **If not:** open the failing step and copy its last screen of output to whoever maintains the portal. A test that
   failed only with a timeout is worth one "Re-run failed jobs" before anything else. The backup test runs Postgres's
   tools inside the database service's own container (`.github/workflows/ci.yml` says why); if it can't, its message
   says what it looked for.
2. **Merge the pull request into `main`.** The proof-of-concept host deploys whatever `main` holds.
   **Pass:** `main` on GitHub shows the merge. **If not:** resolve what GitHub says blocks it, then merge.
3. **Get the host's env file ready before the deploy.** On the host, `~/booster-rocket/.env.poc` needs an `APP_URL`
   line with the portal's address (the new deploy script refuses without one), and the user who deploys must be able to write
   to `~/booster-rocket-backups` (or set `BR_BACKUP_DIR` to a folder they can).
   **Pass:** `grep APP_URL ~/booster-rocket/.env.poc` prints the line, and `ls -ld ~/booster-rocket-backups` shows the
   deploying user as owner (or the folder doesn't exist yet). **If not:** add the line; `mkdir ~/booster-rocket-backups`.
4. **Deploy** as section 8 of [the proof of concept's runbook](poc-linuxdev.md#8-deploy) says, but first bring the
   deploy script itself up to date and take one backup by hand. The copy on the host is older than the backup step and
   the `APP_URL` check, and `deploy.sh` updates itself during its own `git pull` while the old copy keeps running: run
   as it stands, it would migrate the database (every migration since the host last deployed) with no backup first.
   ```bash
   cd ~/booster-rocket
   git pull --ff-only
   scripts/backup.sh ~/booster-rocket-backups
   scripts/poc/deploy.sh
   ```
   The hand-run backup ends with a line saying it was kept; stop there if it doesn't. From this run on, the deploy
   backs up the database before it migrates.
   **Pass:** the last line is `Deployed <short commit>.`, the exit code is 0, and a new `booster-rocket-<time>.dump`
   is in `~/booster-rocket-backups`. **If not:** the exit code says why (the table in that section): 2 refused, 3
   migrations failed, 4 the app didn't become healthy, 6 `git pull` failed, 7 the build failed, 8 the backup failed
   (nothing was migrated and the running app wasn't touched).
5. **Open the Health page** (`/staff/health`, Admin, Health in the staff menu).
   **Pass:** **Version** names the commit just deployed; **Worker** says it woke within the last minute; **Last
   backup** shows the deploy's backup (it also says Documenso's database wasn't part of it: this host has none); the
   address box says the browser reached the portal at its own address.
   **If not:** [Health page warnings](health-warnings.md) has one entry for each line.
6. **Give the host a nightly backup.** As the deploying user, `crontab -e` and add:
   ```
   0 3 * * * cd "$HOME/booster-rocket" && scripts/backup.sh "$HOME/booster-rocket-backups" >> "$HOME/booster-rocket-backup.log" 2>&1
   ```
   Copy `~/booster-rocket-backups` and `.env.poc` somewhere off the server, as [backups](backups.md) says.
   **Pass:** the next morning there is a new dump and **Last backup** says "Recent". **If not:** the log file says why
   (exit 2 a setting or the folder, 3 the database didn't answer, 4 the backup failed).
7. **Restore one backup into a scratch database, once,** so a restore has been carried out on real data:
   `scripts/restore.sh ~/booster-rocket-backups/<newest booster-rocket file> booster_restore_check`, then remove it:
   `docker exec booster-rocket-db-1 psql -U booster -d booster -c "drop database booster_restore_check"`.
   **Pass:** it says `Restored ... (<number> tables ...)`. **If not:** its message and exit code (2 refused, 3 the
   server couldn't be reached, 4 the restore failed and nothing was changed).
8. **Run checks 18 to 24** of [the proof of concept's checklist](poc-linuxdev.md#9-the-test-checklist): who can sign
   in, an edit in QuickBooks that changes no sign-in, blocking and welcome emails. They need edits in the Intuit sandbox
   and a mailbox you can read. Since the portal keeps its own list of each family's guardians, a parent in QuickBooks
   is given no sign-in by it: the host's guardians are the ones it already holds and those staff add on a family's
   page (under **Families**, the **Portal sign-ins** box, **Add guardian**, as in part 6, step 3).
   **Pass:** each step does what its line says; add a row for each to that runbook's Results table.
   **If not:** note the step and what you saw; that runbook's Troubleshooting table covers the usual causes.
   **Check 25, a second sandbox company, waits for the mapping screen:** until
   families can be linked to another company's customers, the portal refuses any company but the one its families were
   read from ([reconnecting QuickBooks](quickbooks-reconnect.md#connecting-a-different-company)), so the host stays on
   the first sandbox company, the one part 2 needs. Don't try it: it is refused and changes nothing, and the roster
   refresh stops while another company's connection is stored.
   **Pass:** Roster still lists the first sandbox company's families, and a test parent can sign in.
9. **Export the audit log once** (Audit in the staff menu, **Export ... (CSV)**) after a parent whose name has an accent
   has signed in, and open the file in Excel or Google Sheets.
   **Pass:** the accent shows as it should, and the columns read well. **If not:** note which program and what it
   showed.
10. **Publish the first release.** Make the version in `package.json` the one you mean (it is `0.1.0`), then run CI
    on `main` by hand and wait for it to finish green: `gh workflow run ci.yml --ref main` (or on GitHub, **Actions**,
    **ci**, **Run workflow**). CI runs on pull requests, not on pushes to `main`, and the release workflow publishes only
    a commit CI has passed on. Then on GitHub, **Releases**, draft a release with the tag `v<that version>` and publish
    it. The release workflow builds, checks and pushes the image.
    **Pass:** the workflow is green, and the repository's **Packages** shows `booster-rocket` with three tags: the
    version, the commit's first 12 characters and `stable`. If clubs are to pull it without signing in, open the
    package's settings and make it public. **If not:** the workflow's log; a tag that doesn't match `package.json`
    stops it at once and says so.
11. **Switch on Dependabot's security updates.** The monthly version updates need nothing, but GitHub opens a pull
    request for a security fix only when the repository asks for them: on GitHub, the repository's **Settings**, **Code
    security**, switch on the **Dependency graph**, **Dependabot alerts** and **Dependabot security updates**.
    **Pass:** the page shows all three on. **If not:** note which can't be switched on (an organization's settings may
    decide it).
12. **Look at the first dependency updates** a few days after pushing (the repository's **Pull requests**).
    **Pass:** each comes as its own pull request (one package, image or action at a time) and CI passes on each.
    **If not:** close any that fail and tell whoever maintains the portal. Read [updates](updates.md) before merging
    one that moves Documenso.

## 2. Check the portal's requests in the Intuit sandbox

The portal's requests to QuickBooks were written from Intuit's documentation, and none had been sent to a real company.
One page now sends each of them to the connected company and says, request by request, whether QuickBooks answered as
the portal expects: **Check the portal's requests** (`/staff/settings/quickbooks/check`), under Settings, QuickBooks.
In a sandbox company it reads and also changes: it makes two test families, a student and a parent (and a second parent, if QuickBooks takes the name again under the other family) named "Booster
Rocket check" with the date, tries every change on them, makes and voids a $1.00 invoice, and leaves them inactive. In
the club's real books it only reads.

1. **On the proof-of-concept host** (connected to the Intuit sandbox), as an Admin, open Settings, QuickBooks, **Check
   the portal's requests**, and select **Run the check**. It takes a minute or two.
   **Pass:** **The last check** says "Every request answered as the portal expects", against "An Intuit sandbox company
   (reads and changes)"; no row under **Changing (sandbox only)** reads "Not tried"; and Health's QuickBooks line says
   when the requests were last checked. A "Noted" row is a fact the check recorded, not a failure: "Pay links on
   invoices" is noted when the check's own invoice comes back without a Pay link, and "A Pay link on a buy-out
   invoice" notes whether a bill-to email address is what gives one (see Results, 2026-11-17). A new row, "Making a
   parent with a name already used under another family", makes a parent under the second test family with the first
   test parent's name: it is always "Noted", since either answer is fine; it tells the portal which one this company's
   QuickBooks gives (a second customer of the same name, or a refusal as a name in use).
   **If not:** "Finished, but some changes weren't tried" means the check couldn't try every change: each "Not tried"
   row says why (a roster read under way: run it again in a minute; no customer type or no product or service in the
   company: add one in QuickBooks, then run it again). For any other result, each row that didn't answer as expected says what it found, what that means for the club, and (for the
   maintainer) which code holds the request. Send a picture of the whole page to whoever maintains the portal. Don't
   connect the club's real books until every row answers as expected. A check that stopped part way is made safe at the
   start of the next run.

The page replaces these checks the roadmap's checks table asked for by hand (each named by the page's own row):

| Roadmap check | The page's rows that answer it |
|---|---|
| The invoice query and its pay link (1 to 6) | Invoices for several customers in one request; Invoices for one customer; Pay links on invoices; What each invoice carries; A family's balance, read by its ID; A request for invoices that matches nothing |
| A sparse update of a phone and a billing address (1 to 6) | A parent changing a phone number; A parent changing a mailing address; Clearing a phone and an address; A phone change from an old version of the record; The longest phone number; The longest address the portal allows |
| The Item query and the item on invoice lines (1 to 3) | The products and services; The product or service on each invoice line; A student's own balance, read by its ID |
| A sparse update of the email field (1 to 6) | A parent changing their sign-in email; An email field holding two addresses; The longest email field; An email change from an old version of the record; An email field that isn't an address |
| The staff roster writes (1 to 6) | Making a family; Making a student under a family; Making a parent under a family; Renaming a family; Moving a student to another family; Making a family inactive while a customer under it is active; Making a family inactive once everyone under it is inactive; Making a customer with an open balance inactive; Making a customer with a name already in use; A rename from an old version of the record |
| Creating and voiding a buy-out invoice (1 to 5, and the void's old-version code in 6) | Making a buy-out invoice on a student; A buy-out invoice is not emailed; Finding a buy-out invoice again; A Pay link on a buy-out invoice; Voiding a buy-out invoice; Voiding an invoice from an old version of it |

The roster's own two checks (the customer query's order and inactive customer types) were made by hand on the proof of
concept on 2026-11-11 (its checks 16 and 17); the page reads the customers and their types again each run.

What the page can't do is walk the portal's own screens. Do these in the sandbox too, on the proof-of-concept host:

2. **Payments, line by line.** In the sandbox, give a family an open invoice on the family and one on a student. Sign
   in as that family's parent and open Payments (`/payments`).
   **Pass:** each invoice, its amount and the total match QuickBooks, and **Pay** opens QuickBooks' own payment page.
   **If not:** note which line differs, and how.
3. **A credit.** Leave an unapplied payment or a credit on that family in QuickBooks, and open Payments again the next
   day (or after Balances, **Read every family now**).
   **Pass:** Payments shows the credit line, and the audit log has one `money.balance_mismatch` row for the family that
   day. **If not:** note what Payments showed.
4. **A parent edits their details.** On a phone, as that parent: Family, **Update my details**, change the phone and
   the address, save.
   **Pass:** the page says "Saved.", the details box on Family and Home shows the new phone, and the audit log has a
   `parent.details.save` row with before and after that reads well. Within a minute or two (the worker's next wake),
   the parent's own record in QuickBooks shows the new phone and address, and the audit log has a
   `roster.customer.contact` row for it; Reconciliation shows nothing waiting for it. Then open the edit page in two tabs, save a change in one and then another change in
   the other: the second says the details changed while you were editing, so nothing was saved, and shows them as they
   stand. **If not:** note what was saved where.
5. **A payment requirement.** In Seasons, give a payment requirement its product (**Read the list from QuickBooks**
   first), and make an invoice for that product in QuickBooks.
   **Pass:** the parent's Season page says "Not paid yet" with the amount; pay the invoice in QuickBooks, then on
   Balances **Read every family now**, wait for the worker, and the Season page says "Paid".
   **If not:** note what the Season page and Balances said.
6. **A buy-out, start to end.** Offer a buy-out on a volunteer requirement (its page, with a price and a product).
   As a parent, on Volunteer, **Pay instead of volunteering**, then **Confirm: invoice me <amount>**.
   **Pass:** the invoice reaches Payments with a **Pay** button; pay it in QuickBooks, ask for a read on Balances, and
   the requirement goes from "Buy-out invoiced" to "Paid instead". Choose another and switch back before paying: the
   invoice is voided in QuickBooks. Note whether online payment needed more than the ACH flag the portal sets (if the
   invoice has no **Pay** button, it did). The invoice carries, as its bill-to address, the sign-in email of the
   parent who chose it (in the sandbox, QuickBooks gave a Pay link only to an invoice with an email address), and
   nothing is emailed: check that no email from QuickBooks reaches that parent.
   **If not:** Reconciliation lists a buy-out that needs a look; note what it says.
7. **An email change on a phone.** As a parent: Family, **Change my sign-in email**, a new address you can read. Open
   the emailed link on the phone while signed out.
   **Pass:** you sign in with the old address and land back on the question; confirming signs you out, and you sign in
   with the new address; after the worker's next wake (a few minutes), the parent's own record in QuickBooks shows the
   new address in its email field in place of the old, and any other address in it as it was. **If not:** note where it
   went instead, and what Reconciliation says of the change.
8. **A staff change that waits.** The portal puts a roster change on its queue when QuickBooks is busy or can't be
   reached, which can't be made to happen from the portal. The first time Health's QuickBooks line counts a change
   waiting, open Reconciliation.
   **Pass:** the change goes from Waiting to done on its own, and QuickBooks has it once, not twice.
   **If not:** note the change and what Reconciliation said; [Health page warnings](health-warnings.md#quickbooks) says
   what to do with a stuck one.
9. **A student moved from the portal, then in QuickBooks itself.** Give a test student an unsigned form and a place on
   a shift still to come, then move the student under another test family from their family's page in the portal.
   **Pass:** QuickBooks shows the student under the new family; the new family's Forms page offers the student's form
   to sign; the old family's guardian gets "Your place has been freed" for the shift; the audit log shows "What
   follows a student who moved to another family was recorded" with the cause `roster.student.move#` and a number.
   Then move the student back in QuickBooks itself and press **Refresh** on the Roster page: the portal still has them
   in the new family (a change made in QuickBooks no longer changes the portal's families), and nobody is mailed.
   **If not:** note what each family's pages show.
10. **Closing a buy-out sends nothing.** With a refused or flagged buy-out on Reconciliation, choose **Close this
    buy-out**, give a reason and **Close it**; then open the family's **Its volunteer buy-outs** page.
    **Pass:** the page says how the buy-out ended, the family can choose again, and in QuickBooks no invoice was made,
    voided or changed. On a phone and a laptop, the confirm, the reason field and **Close it** / **Keep it** read well
    and are easy to tap. **If not:** note what changed in QuickBooks.
11. **The products and services after a daily run.** After the next daily read of every family, open a payment
    requirement's page. **Pass:** it still names its product or service, as the list read by **Read the list from
    QuickBooks** did. **If not:** note what it names.
12. **Making a family inactive.** Give a test family a student and a parent, and an open invoice on the student. On
    the family's Roster page, open **Change the family**, choose **Make <family> inactive**, read the list, and
    confirm.
    **Pass:** the list names the student and the parent, then says the family goes last; with the invoice open,
    nobody is made inactive and the page names the student as having an open balance (with the amount only for staff
    who can see Balances), saying it must be settled in QuickBooks first. Void the invoice in QuickBooks,
    confirm again: the student and the parent, then the family, are inactive in QuickBooks, and the family's parents
    can no longer sign in. **If not:** note what the page said and what QuickBooks shows for each.
13. **A family added in the portal.** As an Admin (who may link families to accounting), on the Roster page use
    **Make a family** for a test family. Then, signed in as a staff member whose role may change families but not link
    them, make a second test family, give it a student on its page, and add a test guardian. Then, as the Admin, open
    the second family's page and press **Create in QuickBooks and link**.
    **Pass:** the first family is in QuickBooks once, and its Roster row says it is linked. The second says, when it
    is made, that nothing was sent to QuickBooks; it is listed as not linked, QuickBooks doesn't have it, and its
    guardian can sign in to it. After **Create in QuickBooks and link**, QuickBooks has the family once with the
    student under it, and both rows say linked. **If not:** note what each page said and what QuickBooks shows.

## 3. Real phones

Use an iPhone (Safari, and the portal added to the home screen) and an Android phone (Chrome, and the portal installed
from Chrome), on the proof-of-concept host, signed in as a test parent. First set the club's time zone (Settings,
Club, **Change**): until it is set the portal uses UTC, so dates and shift times turn over at the wrong hour.

1. **Install it on the iPhone:** in Safari, Share, **Add to Home Screen**.
   **Pass:** the icon is the club's short name on the club's color, and the label under it is the club's name (12
   characters or fewer) or its short name. **If not:** a picture of the home screen.
2. **The installed app's edges, on the iPhone,** in light and dark mode and turned sideways.
   **Pass:** the status bar is readable above the club bar, nothing sits under the notch, the bottom tabs sit above the
   home indicator, and the last line of Home scrolls clear of the tabs. **If not:** a screenshot.
3. **Sign in from the installed app,** leaving it in the middle: ask for a code, switch to Mail, come back. Once more,
   force-close the app before coming back.
   **Pass:** you are still on the code screen with the resend countdown, and the code signs you in.
   **If not:** note where you landed.
4. **Stay signed in.** Open the installed app again more than 7 days after signing in.
   **Pass:** still signed in (a parent stays signed in for 90 days, renewed by use). **If not:** note how long it was.
5. **Come back to the page asked for.** Signed out, open `/payments` (or `/display`), sign in.
   **Pass:** you land on that page, not on Home. **If not:** note the page you asked for and where you landed.
6. **Figures that refresh.** Leave the installed app for over a minute and come back.
   **Pass:** the "as of" time on Home moves on without a touch. **If not:** note the times.
7. **A link opened inside another app,** on the iPhone: open the portal's address from Gmail or another app's own
   browser, then Display.
   **Pass:** the box says to open the page in Safari first. **If not:** a screenshot.
8. **Install on Android:** Chrome offers to install; on Display, and under the sign-in form, **Install** opens the
   install prompt.
   **Pass:** both open it, and once installed the icon's letters aren't clipped on round, squircle or themed icon shapes,
   and the status bar and splash screen take the club's color. **If not:** a screenshot.
9. **Offline.** In the installed app, turn on airplane mode and reload.
   **Pass:** "You're offline" with **Try again**, which brings the page back once you're online again.
   **If not:** note what showed instead.
10. **No install box inside the app.** In the installed app, open Display.
    **Pass:** no "Add the portal to your home screen" box. **If not:** a screenshot.
11. **A new icon.** Change the club's color or short name (Settings, Club, **Change**), then install again.
    **Pass:** the new icon, and the browser tab's icon, show the change. **If not:** note which kept the old one.
12. **The sign-in pages on a phone:** `/sign-in` and `/staff/sign-in`.
    **Pass:** the club bar shows on both; under the parent form the install box offers itself, and **Not now** keeps it
    away on that phone. **If not:** a screenshot.
13. **Home on a phone.** **Pass:** it reads in order (greeting, the money box under the family's name, students,
    details), the season ruler's step names fit or hide cleanly, the current set shows the club color, each student's
    dot is readable, and the tabs are easy to tap (and, for a parent in two families, **Switch family** on Family).
    **If not:** a screenshot.
14. **Display modes.** On Display, try dark, high contrast and the largest text size, then open Home, Volunteer, a
    shift and a form's page.
    **Pass:** the filled account circle on Display is readable against the club color; nothing scrolls sideways, the
    five tabs keep their words, and moving the focus (a keyboard or switch) never leaves it under the tab bar. With a
    keyboard (or a switch), the first Tab on Home shows **Skip to the page** at the top of the club bar with a ring,
    and Enter moves on past the bar.
    **If not:** a screenshot, with the mode.
15. **Pay from the installed app.** On Payments, **Pay**.
    **Pass:** QuickBooks' payment page opens in the app's own browser view, with a way back to the portal.
    **If not:** note whether it opened at all, and where.
16. **Sign up for a shift** on each phone.
    **Pass:** the confirmation email arrives with its calendar file attached (this host sends through Microsoft 365, so
    that is the Microsoft 365 check too), and the file adds the shift at the right local time: on the iPhone in Mail
    and Calendar, on Android in Gmail and Google Calendar. **If not:** note the time it showed, or that no file came.
17. **Check in with the shift's code.** As staff, open the event under Volunteering, **Check-in code to print**
    (`/staff/volunteer/check-in/<shiftId>`), and print it.
    **Pass:** the sheet prints on one page, and the address written on it is the portal's own. Within the check-in
    window (from half an hour before the shift until it ends):
    - **On an iPhone,** the camera offers the link when it sees the code. It opens in **Safari, not in the installed
      app**: on an iPhone only an app from the App Store can open its own links, and the portal added to the home
      screen is not one. If Safari has no session yet, the volunteer
      signs in there with their email code once (Safari then remembers them, as the installed app does), and is brought
      back to the check-in page. They tap **Check me in**, and the page says so.
    - **On an Android phone,** the camera opens the link in Chrome, which may offer to open it in the installed app.
      Either way the volunteer lands on the check-in page, signed in or after signing in, and checks in.
    **If not:** note the phone, what the camera offered and where it went.
18. **Reminders in a real mail client.** On this host only (its families are test families), switch parent sign-ins
    and welcome emails on, and give a test family a shift tomorrow, a volunteer requirement due soon, and a form with
    a reminder schedule, and an unpaid payment requirement and an unticked checklist item both due in 14 days.
    **Pass:** the day-before reminder, the due-date nudge, the scheduled form reminder and the payment and checklist
    reminder each arrive after 9:00 in the club's time zone, and read well in Gmail or Outlook on a phone; the payment
    and checklist reminder's links open Season and Payments after signing in. Health's "Payment and checklist
    reminders" and "Volunteer reminders" lines say when they last looked. **If not:** note which didn't arrive, and the
    Health page's mail line.
19. **A screen reader on each phone:** VoiceOver on the iPhone, TalkBack on Android (or Narrator on Windows). Sign up
    for a shift, cancel it, then check in at a shift.
    **Pass:** the thank-you, "Cancel my sign-up?", the cancelled message and the check-in message are each read, once.
    **If not:** note which wasn't read, or was read twice.
20. **Staff pages on a phone,** as an Admin: Menu, then the Roster, Balances, Signed forms and a volunteer event.
    **Pass:** each group's name and links read clearly, the menu panel scrolls when it's long, each table row stacks
    with its labels, and no page scrolls sideways. **If not:** a screenshot.
21. **Staff pages with a screen reader and in contrast themes,** on a computer.
    **Pass:** with NVDA or VoiceOver, Tab to Families in the staff menu: it is read as a collapsed button, expanded after
    Enter, and Escape returns to it. With high contrast on (Display, or the device's own), a staff form's busy button
    shows a dashed border, not a filled one. In a Windows contrast theme (Settings, Accessibility, Contrast themes), the
    staff tick boxes and radio marks still show which is checked, notices keep their border all round, their icon cell's edge, their word and their icon, and on
    Home and Display the current set, the checked option and the focus ring are visible. In that theme too, the first
    Tab on a parent page and on a staff page shows **Skip to the page** with its ring, and Enter moves on past the bar.
    **If not:** note the page and what was missing.
22. **The staff home for someone with one permission.** Give a test staff member a role with one of the staff home's
    four permissions only, and sign in as them.
    **Pass:** the Today box shows only that permission's line. **If not:** note what else showed.

The phone checks that sign a form need Documenso, so they are in part 4.

## 4. Documenso and Entra: a full installation

The proof-of-concept host has no Documenso. Forms need a full installation from `deploy/`, with two real addresses
(the portal's and Documenso's). This part is also the first real run of [a first installation](first-install.md).

1. **Install** by [a first installation](first-install.md), on a fresh machine (or the proof-of-concept host, in a
   folder of its own) with two real names, with `--profile proxy` or a proxy of your own. On setup's Step 1, try a
   light club color (for example yellow) first.
   **Pass:** both addresses answer over https with a certificate (with this installation's own proxy, Caddy gets
   them); the preview bar's text on a light color is dark and readable; setup ends with you signed in as the Admin; the
   first backup holds both databases; the installed app's icon and title use the club's new name.
   **If not:** `docker compose logs <name>` for the part that stopped, as the first start says, then note the step and
   the message.
2. **The machine reaches its own two addresses,** the check in [the first start, item 5](first-install.md#5-the-first-start).
   **Pass:** both commands print `200`. **If not:** the "NAT loopback" fix that item gives; until both print `200`,
   forms can't be signed.
3. **The visitor's address.** With this installation's own proxy, `CLIENT_IP_HEADER` is `x-forwarded-for`. With a
   proxy of your own, it must send the visitor's bare address in `X-Forwarded-For` and in the header
   `CLIENT_IP_HEADER` names, and compress responses ([a proxy of your own](first-install.md#a-proxy-of-your-own)).
   **Pass:** sign in once from a phone on mobile data: the audit log shows the phone's public address, not the
   proxy's, and Health's parent sign-ins line doesn't warn about addresses. **If not:** find the header the proxy really
   sets, put it in `CLIENT_IP_HEADER` in `deploy/.env`, and `docker compose up -d app`.
4. **Staff sign-in for real.** Sign in once with the club's Microsoft (Entra) or Google staff sign-in.
   **Pass:** you reach the staff home. On Settings, Staff sign-in, **Change**, a Microsoft certificate reads "Done:
   Microsoft accepted this certificate", and **Download certificate (.cer)** saves the file and then shows its
   thumbprint without a reload. The staff script (`New-BoosterRocketStaffApp.ps1`) ends by saying to finish "in the
   portal: on the setup page, or under Settings". **If not:** a screenshot of the page.
5. **The signing certificate,** by [Documenso, part 1](documenso.md#1-make-the-signing-certificate).
   **Pass:** `<DOCUMENSO_URL>/api/health` says `"certificate":{"status":"ok"}`, and the `.p12` with its passphrase is
   kept somewhere safe off the machine. If the club wants PDF readers to show the signer as trusted, a certificate from
   a certificate authority is the way (Documenso's documentation, "Signing certificate").
   **If not:** the file's owner and mode (`chown 1001`, `chmod 400`), and the passphrase in `deploy/.env`.
6. **Decide the trusted timestamp** ([Documenso, "Trusted time on signatures"](documenso.md#trusted-time-on-signatures-a-decision-for-the-club)):
   the server's own clock (`DOCUMENSO_TIMESTAMP_AUTHORITY` empty), or a timestamp service's address.
   **Pass:** the choice is written in `deploy/.env` and in the Results table. Changing it later affects only forms
   sealed afterwards.
7. **Documenso's own mail** through Microsoft 365 SMTP ([Documenso's account mail](mail.md#documensos-account-mail)).
   **Pass:** Documenso's **Forgot password** for the forms account sends the reset email. **If not:** if the tenant
   switches SMTP sign-in with a password off, use another SMTP service for Documenso, as that section says.
8. **Documenso's first account, and the connection,** by [Documenso, parts 2 and 3](documenso.md#2-the-first-documenso-account).
   **Pass:** in Settings, Forms (Documenso), the address is exactly `DOCUMENSO_URL`; **Check the connection** answers;
   after **Make the secret** and the webhook in Documenso, one signed form moves Health's forms line's **Last webhook**.
   **If not:** [Health page warnings, Forms](health-warnings.md#forms-documenso).
9. **The club's real templates** have read-only text fields labelled "Student name" (or "Family name"), "Guardian 1
   name" and "Guardian 2 name".
   **Pass:** attaching each to its form requirement is accepted. **If not:** the page says what is missing; add it in
   Documenso and attach again.
10. **The lawyer's look.** Have the club's lawyer read the consent text parents agree to before signing
    (`src/lib/forms/consent.ts`, version 2026-11-16; a form's page shows it above **I agree to sign
    electronically**), and one sealed PDF with its certificate page and the audit log (a staff member downloads them
    from Signed forms, the form's evidence page).
    **Pass:** the lawyer is content, in writing. **If not:** what they want changed in the words is a change to the
    portal for whoever maintains it (a new consent version).
11. **Sign a form on each phone:** the iPhone in Safari, the iPhone's installed app, Android in Chrome. Open a form,
    **I agree to sign electronically**, sign with a finger in the frame. Leave Safari's "Prevent Cross-Site Tracking"
    on (its default).
    **Pass:** the page says "Signed". On the form's certificate page in Documenso, the address is the phone's public
    address. With the phone held upright, Documenso's own **Sign** button in its signature dialog isn't hidden under the
    portal's tab bar (the walk found it can be at 390 wide; `docs/ui-backlog.md`). **If not:** note the phone and the
    step; a frame that loads and then can't be signed usually means the Forms address isn't exactly Documenso's own. A
    Sign button under the tab bar: a screenshot, with the phone.
12. **The guardian's copy.** Open the sealed PDF a guardian got by email, in Outlook or Gmail on a phone, then in Adobe
    Acrobat Reader (or `pdfsig`).
    **Pass:** the attachment opens and the signature panel says the document hasn't changed since it was signed (with
    and without a timestamp service, if you tried both). **If not:** keep the file and note what the reader said.
13. **A large copy through Microsoft 365.** With the portal's mail through Microsoft 365, sign a form whose sealed copy
    is just under 3 MB, and one over.
    **Pass:** the first arrives attached, the second as a link to the form's page. **If not:** note the size and what
    arrived.
14. **Start again in the real Documenso,** once on a declined form (Documenso deletes it) and once on a half-signed one
    (Documenso cancels it): Signed forms, the request's page, **Start again**, with a reason.
    **Pass:** each is withdrawn in Documenso and the family is asked to sign again. **If not:** note the request and
    what the page said.
15. **The signing frame by keyboard.** On a computer, open a form, agree with the keyboard.
    **Pass:** the focus lands in the signing frame, and Tab gets back out of it. **If not:** note where the focus went.
16. **VoiceOver and TalkBack in a form** (or Narrator on Windows): open a form's page, agree, and land in the signing
    frame.
    **Pass:** the page's title read on arriving is the form's own name (for example "Travel consent"), not "Form"; the
    frame is announced, and you can leave it again. **If not:** note what was read.
17. **Optional: staff sign in to Documenso with the club's Entra.** Register a single-tenant app, set the
    `DOCUMENSO_OIDC_*` lines and skip-verify ([Documenso, "Staff sign-in to Documenso"](documenso.md#staff-sign-in-to-documenso-with-the-clubs-own-sign-in-optional)).
    **Pass:** a staff member with a mailbox signs in, one without is refused, and once invited to the club's
    organisation they see its templates. **If not:** note what Entra or Documenso said.
18. **Restore both databases once** into `booster_restore_check` and `documenso_restore_check`, as
    [backups, "Checking a backup can be restored"](backups.md#checking-a-backup-can-be-restored) says. If you want it
    proven end to end, start a second Documenso against the restored database.
    **Pass:** each says `Restored ...`. **If not:** its message and exit code.

The Documenso verification's own owner checks (its section 9, in `docs/superpowers/specs/2026-11-15-documenso-verification.md`)
are here: its 1 and 2 (signing on an iPhone and on Android) and 4 (the phone's address on the certificate page) are
item 11, its 3 (Entra) item 17, its 5 (Adobe Reader's signature panel) item 12, its 7 (timestamps) item 6 and its 8
(the lawyer) item 10. Its 6, about a managed database service, doesn't apply: this installation runs its own Postgres.

## 5. Intuit's production assessment

Intuit gives the Production keys, the ones that reach the club's real books, only after its assessment, and that can
take weeks. Start it as early as you like; it doesn't wait for the parts above.

1. **Walk [Intuit, part 3](intuit.md#3-the-production-assessment).** Its steps were written without seeing Intuit's
   screens.
   **Pass:** Intuit approves the app and the Production **Client ID** and **Client secret** appear. Note any screen
   that didn't match the runbook. **If not:** answer Intuit's questions by email; the runbook's "true answers" are a
   start.

## 6. Connect the club's real books

1. **Connect the real books** by [Intuit, part 4](intuit.md#4-connect-the-clubs-real-books), as the first company of
   the installation families will use. That installation must never have read a sandbox company's customers: until the
   mapping screen ships it would refuse the real books
   ([reconnecting QuickBooks, a different company](quickbooks-reconnect.md#connecting-a-different-company)). The
   proof-of-concept host stays on the sandbox; the club's installation is a fresh one ([first install](first-install.md)).
   **Pass:** Health says QuickBooks is "Connected" to the club's company, with no word of a sandbox; Roster's counts
   line has the counts QuickBooks has. A fresh installation lists no families yet: a read of QuickBooks brings no
   customer into the portal's own families by itself. On **Reconciliation**, **Customers with no family** lists the
   active family customers of the real books at the top level (under no other customer); a family that is inactive in
   QuickBooks, or sits under another customer there, isn't offered, so make it active, or move it to the top level, in
   QuickBooks first; **Create a family from this** brings each in, with its students, linked to
   their customers. Bring in the pilot families this way, then add their guardians on each family's page, and check
   each family's page shows its students. Making a family reads none of its money: on **Balances** press **Read every
   family now** (or wait for the next daily read), then check the Balances page shows each pilot family's money. The
   reviewed import of every family at once comes with stage 4 of the roadmap.
   **If not:** [reconnecting QuickBooks](quickbooks-reconnect.md).
2. **Check the portal's requests against the real books.** Settings, QuickBooks, **Check the portal's requests**,
   **Run the check**. Against the real books it only reads.
   **Pass:** every reading row answers as the portal expects. **If not:** as in part 2; don't switch parent sign-ins on
   until it does.
3. **Read who can sign in:** Settings, Parent sign-ins. Who can sign in is the portal's own list of each family's
   guardians, not QuickBooks' parents.
   **Pass:** the number of people and families looks right for the guardians the portal holds, and **Parents** lists
   each one with their families. **If not:** a guardian you expected and don't see is the portal's to add, not a
   QuickBooks record to fix: on the family's page under **Families**, the **Portal sign-ins** box, **Add guardian**,
   with their name and the email address they will sign in with. Nobody can sign in, whoever you add, until parent
   sign-ins are switched on (part 7). A guardian who shouldn't sign in for a family any more is removed from the same
   box (**Remove**, with a note only staff see): they are signed out of that family at once.
4. **The daily read of every family's invoices, at the club's size.** The day after connecting, open Health.
   **Pass:** **Every family's invoices** is "Working" and finished within the day. A run longer than a few minutes
   carries on at the next wake by itself. QuickBooks turning the portal away for asking too often shows as a stop with
   `http_429` in the line's note; there should be none. The **Buy-out invoices** and **Volunteer reminders** lines
   read sensibly too: when the daily check and the reminders last looked, and nothing that needs attention.
   **If not:**
   [Health page warnings, every family's invoices](health-warnings.md#every-familys-invoices), and that page's entry
   for the line.
5. **The products and services:** on a payment requirement's page, **Read the list from QuickBooks**.
   **Pass:** the club's items are listed and a requirement can name its own. **If not:** note what the page said.
6. **Read Accounting links against the real books** (`/staff/links`, Accounting links under Families; it takes the
   permission to link families to accounting). It sends nothing to the books: a family the portal has is linked there
   to its customer, left unlinked, or unlinked again, and nothing else on it changes anything.
   **Pass:** every family you brought in reads **Linked**, confirmed by you, on the day you pressed; a family you added
   on Families while QuickBooks was connected reads **Linked**, made in the books from the portal, by you; a family
   added with no customer (by someone who may not link families, or while QuickBooks was disconnected) reads
   **Suggested** only where one of its guardians signs in with an address that really is on a customer no family is
   linked to (or on a parent record under it), and otherwise **Several possible** or **No match**. For such a family,
   open its row: a Suggested one lists the students **Confirm** would link with it (a name on exactly one student on
   each side) and those it would leave; press **Confirm** where the customer really is that family's, and it reads
   **Linked**, confirmed by you, or **Linked, with differences** while anything is left over: a student left is shown
   among its differences (an inactive student customer left is only counted on the row), and, in books with a parent
   type, so is each guardian whose own Parent customer isn't linked yet (Confirm never links a guardian's), which is
   every confirmed Suggested family there. Its money is read at its next page load. A Several possible or No match family takes **Pick a different customer**, from the customers no family
   is linked to, with the same confirm step; **Leave unlinked** keeps a family with no customer in the books yet out
   of the suggestions until you undo it. With several Suggested rows, **Confirm all exact email matches** above the list
   links every Suggested row the filter shows, its count on the button, each as its own **Confirm** would; narrow the
   list with the status or the search first to link fewer. A link carried over from the roster (on an installation
   that had families before) offers **Confirm this link** in its row, which records it as checked by you. A linked family's row
   offers **Unlink from the books**: unlink a test family you linked, and its row reads Suggested or No match again,
   its guardians' Home and Payments say the club hasn't connected their payments yet, and Balances counts it in one
   line; link it again with **Confirm** (a Suggested row), or, for another customer, **Leave unlinked** and then **Pick a
   different customer**, and its money is read afresh. Reconciliation
   refuses **Create a family from this** for a customer Accounting links suggests or lists for a family the portal has,
   and its row names that family and links to Accounting links; don't press **Create in QuickBooks and link** for a
   family whose customer is already in the books (it would make a second customer); and the
   count of customers with no family matches Reconciliation's list. A linked family whose records differ from the
   books' copy reads **Linked, with differences** instead, still saying how its link was made, and its row's opening
   lists each difference with the portal's value and the books': a family you brought in has the Parent customers
   QuickBooks holds under it counted until its guardians are linked to them; rename a student in QuickBooks, refresh
   the roster, and that family shows both names; a student moved to another family in QuickBooks shows where
   QuickBooks has them, in the words the family's page uses; a change waiting or kept on Reconciliation is named in
   Reconciliation's words with a link there. Under the status filter, Carried over and Linked, with differences can
   count the same family, and the page says so. **If not:** note the family, the status it read and
   what you expected; a suggestion that names the wrong customer is the most important to report, then a difference
   that isn't one (both values the same) or one the page misses.

## 7. A pilot with a few families

1. **Choose three to five families** who will tell you what confused them. Check each has its guardians in the portal,
   with the email address each signs in with, and add any that are missing on the family's page (part 6, step 3).
   **Pass:** **Parents** lists each of their guardians, and Settings, Parent sign-ins counts them among those who could
   sign in.
2. **Switch parent sign-ins on, and leave welcome emails off:** Settings, Parent sign-ins, **Set up** (or
   **Change**), step 1, **Switch parent sign-ins on**.
   **Pass:** the step says "Parent sign-ins are on." No email goes to anyone: every guardian the portal holds could now
   sign in, but only those you tell will know to. Scheduled reminders stay off while welcome emails are off;
   don't press **Remind now** on Signed forms during the pilot: it emails every guardian still to sign that form.
   **If not:** the step lists what is missing first (working mail).
3. **Tell the pilot families** the portal's address and to sign in with their email. Ask each to, on their own phone:
   look at Home and Payments, sign a form, sign up for a shift and check in at it, update their details, and try
   Display.
   **Pass:** each finishes without help (the product's first principle). **If not:** write each place they got stuck
   in `docs/ui-backlog.md`, with the page and the date.
4. **Watch while they do:** Health, the staff home and the audit log.
   **Pass:** nothing on Health needs attention because of them, and the audit log shows their sign-ins and changes.
   **If not:** [Health page warnings](health-warnings.md).

## 8. Switch welcome emails on

1. **Settings, Parent sign-ins, step 2, "Welcome emails".** Read the sample email and how many people would be emailed
   now, then **Switch welcome emails on**.
   **Pass:** they go out a few each minute; Health's mail line stays "Working". From now on, scheduled form reminders,
   volunteer due-date nudges and the payment and checklist reminders also go, from 9:00 club time. **If not:** **Switch welcome emails off** stops the rest
   at once; Health's mail line says why sending failed ([outgoing mail](mail.md)).

## Choices to confirm

These are decisions, not checks. Each was made while building, so the portal works one way today; say if it should
work another. Any time before the pilot.

1. Whether a requirement can cover a student by grade or section, and if so where a student's grade comes from:
   QuickBooks holds none. Today coverage is everyone, or a hand-picked list of families or students.
2. A waiver's reason stays hidden from the family (they read "Waived"); parents read "set" where staff read "step";
   all four season permissions are ordinary ones a custom role can hold.
3. Until the mapping screen ships, a QuickBooks company other than the one the portal's families were read from is
   refused, so nothing a season holds (ticks, waivers, chosen lists, reminders sent) can be lost to a change of company.
   The lead's decision, with no exception for an installation that holds no season records yet.
4. The cancelling cut-off for a shift is 48 hours before it; a staff tick no longer counts for volunteering; a declined
   form still gets reminders.
5. A parent changes their own sign-in email in the portal, whatever families they are in. Until the staff email change
   ships (open question 8 of the app-owned families spec) the club can't change it for them: a change made in
   QuickBooks no longer changes anyone's sign-in address.
6. The staff menu's groups (Families, Season, Money, Admin, with Reconciliation under Money and Settings as one entry)
   and its labels ("Signed forms", "Volunteer credit", "Reconciliation"); the mapping screen's name and place,
   "Accounting links" under Families after Parents, shown to whoever may link families to accounting and see the
   roster; setup asks for the club before the first
   Admin; a role saved from the checklist no longer takes up new permissions by itself.
7. A buy-out is billed in the company's home currency with no due date sent; credit earned after a buy-out still counts
   toward the requirement but doesn't lower the invoice; a student moved in QuickBooks is no longer followed (stage 3's
   slice 9c): their forms, places and per-student buy-out stay with the family the portal holds them in, and nothing is
   voided, until staff move them from the portal, which voids an unpaid per-student invoice through the queue.
8. Any guardian of a family can check in another guardian's own place ("Check everyone in").
9. Checking in from inside the installed app: decided on 2026-11-16 (the roadmap): scanning the shift's code with the
   phone's camera stays the way, and on an iPhone that opens Safari. Native apps may come later.
10. Whether the Family page should name a person's other families (it gives the count and **Switch family**).
11. The words parents read when something isn't there yet, for the voice: "For now, the club makes changes for you. Ask
    the club and they'll update it.", "Your family isn't set up here yet", "The club has no active students listed for
    your family right now." and "Sign in to see your students and what's owed."
12. Whether opening the audit log, filtered to one person's records, should itself be written in the audit log. Today
    only an export is.
13. Before an update changes a database that holds data, `deploy/`'s start stops unless the last good backup is less
    than 26 hours old ([updates, "When the start stops for a backup"](updates.md#when-the-start-stops-for-a-backup)).
    The 26 hours was chosen while building. To try it: on an installation with data, start a new version with no
    backup from the last 26 hours; `docker compose logs migrate` shows the refusal, and after
    `docker compose run --rm backup --now` the start goes ahead.
14. Payment and checklist items are reminded 14 and 3 days before their due date, with no schedule of their own, and
    a payment's reminder says its amount only from figures read in the last few minutes, so most say "Not paid yet".
15. Staff can make a customer inactive from the roster pages, but not active again: that was left out while building
    because it widens what the portal changes in QuickBooks. A customer can be made active again in QuickBooks
    itself, but the portal's own family or student stays inactive: no roster refresh changes the portal's families
    and students any more. Taking such a change into the portal waits for the mapping screen's "Take QuickBooks'
    into the app" (the roadmap's stage 4).
16. The lead's choice, not the owner's (2026-11-17): making a family inactive is never put on the write queue to be
    sent later. When QuickBooks can't be reached part way, it stops, says who was made inactive and who wasn't, and
    staff press it again later. A step whose answer was lost asks for a roster refresh and waits on the queue only to
    be looked for after it, so the portal's own record follows without anything being sent twice. One student or
    parent made inactive by itself waits on the queue only when its send is cut off; when what they owe can't be read,
    it is refused and staff press it again later (stage 3's slice 9g).
17. Since stage 3's slice 9g (the app-owned families spec's open question 11): a credit (a negative balance) stops a
    make-inactive as an amount owed does, before anything is sent; it has to be used or refunded in QuickBooks first.
    Whatever QuickBooks refuses is still told in words.
18. The lead's choice, not the owner's (2026-11-17): when a family is made inactive, its own last write is sent with
    the version QuickBooks has just after its students and parents were made inactive, read again at that moment
    (QuickBooks may raise a family's version when a customer under it changes). Since stage 3's slice 9g no step
    carries the page's version: a student is sent with their link's own, anyone else with the one just read, and a
    stale answer is settled by reading whether QuickBooks has them inactive. The write changes only whether it is
    active, so nothing anyone changed is overwritten. The check's "Making a family inactive once everyone under it is
    inactive" row says whether QuickBooks raises it: on its second run (2026-11-17) it left the family's version as it
    was.
19. The lead's choices, not the owner's (2026-11-19, stage 3's slice 7b): nobody can sign in until parent sign-ins
    are switched on, not even before they were first switched on (earlier, a sign-in seeded by hand worked until
    then); adding, removing and reinstating a guardian take the permission that changes a family
    (`Roster.Family.ReadWrite`), since each gives or ends an address's view of a family (its invoices, its forms to
    sign, a buy-out to confirm): anyone who can change families can give an address a parent's view of one, and every
    such grant is audited with who made it; changing a person's name takes the same permission as blocking
    (`Parents.ReadWrite`); an address that belongs to someone already is added only after staff are shown who that is
    and say it is the same person; removing a guardian needs a note, kept for staff in the audit log; and a guardian
    can't be added to a family with no customer in QuickBooks linked to it until the portal's changes are sent on to
    QuickBooks.

## Results

Add a row for each item each time you do it.

| Date | Part and item | Pass, fail or skipped | What you saw |
|---|---|---|---|
| 2026-11-17 | 2.1 | Fail (34 of 37 rows as expected) | On the proof-of-concept host against an Intuit sandbox company. "Making a family inactive": not as expected, refused with code 800; the check's clean-up later made all five of its records inactive, students and parents first. "Making a customer with an open balance inactive": noted, refused with code 6220. "Pay links on invoices": noted, 8 of 9 invoices carried a Pay link (on developer.intuit.com, the sandbox's); the one without was the check's own, made as a buy-out invoice is made. The owner then decided: a family is made inactive in one action, everyone under it first, and nobody with a balance is made inactive. The check now expects 800 and 6220, and adds a Pay link probe; run it again. |
| 2026-11-17 | 2.1 | Pass (every request as expected) | Run again at 6:03 PM against the Intuit sandbox company: every request answered as the portal expects. "A Pay link on a buy-out invoice": made as a buy-out invoice was made then, with no email address, the invoice came back without a Pay link; made again carrying a bill-to email address, it came back with one, its email status still not set (nothing was emailed). So QuickBooks gives a Pay link only to an invoice that carries an email address. "Making a family inactive once everyone under it is inactive": making the customer under the family inactive left the family's own version as it was. The owner then decided ("go with your recommendation"): a buy-out invoice carries, as its bill-to email, the sign-in address of the guardian who chose the buy-out; nothing is emailed by the portal or by QuickBooks. |
