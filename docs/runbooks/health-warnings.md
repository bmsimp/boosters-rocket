# What to do when the Health page warns

**Health** in the staff menu (under **Admin**, for Admins only) has one line for each part of the portal, with a word for its state and
when it last worked. "Needs attention" or a red word means someone should look; "Off" or "Not set up" may be a choice.
Each entry below starts with the line's title and the words it shows.

Commands run on the server, in `~/booster-rocket/deploy`; add the `-f` files and `--profile` you start the
installation with. `docker compose ps` shows what is running, and `docker compose logs <name>` why something stopped.

## Database

- **The Health page doesn't open at all, or every page says something went wrong.** The portal can't reach its
  database. Run `docker compose ps`: `db` should say `healthy`. If it isn't running, `docker compose up -d` and
  `docker compose logs db`. A full disk stops Postgres: `df -h` shows it; remove old files you don't need (never the
  database's volume or the backups you still want).

## Worker

- **"The worker has never checked in"** or **"The worker has stopped checking in."** The worker wakes every minute to
  run the scheduled jobs; without it QuickBooks isn't refreshed, emails aren't sent and nothing is cleaned up.
  `docker compose ps` should show `worker` as `Up`. If not: `docker compose up -d worker`, then
  `docker compose logs worker`. "couldn't reach the app" there means the app is down: see the database line, and
  `docker compose logs app`.

## Daily clean-up

- **"Not yet run"** on a new installation is normal: it runs once a day.
- **"The last clean-up couldn't finish."** The worker tries again in 15 minutes. If it keeps failing, the note under the
  line has the reason; check the worker line too.

## QuickBooks

- **"Not set up."** Nothing to fix until the club connects QuickBooks: [Intuit](intuit.md).
- **"Not connected."** The app's keys are saved but the connection was ended. An Admin reconnects:
  [reconnecting QuickBooks](quickbooks-reconnect.md#the-same-company).
- **"Needs attention"**, with one of these notes:
  - "The QuickBooks connection couldn't be refreshed" or "expires within 30 days": reconnect the same company.
  - "The last roster refresh failed": the note gives Intuit's reason. If it repeats, check that the Intuit app's keys
    are still valid on the developer site, then reconnect. A refresh only stores QuickBooks' customer list: it changes
    none of the portal's own families, students or sign-ins, so while it fails the portal goes on as it was, with
    families seeing their invoices as last read. (An older run may still give a reason that is the portal's own: "The
    parent sign-ins couldn't be brought up to date" (`reconcile_failed`), "The portal's own family and student records
    couldn't be brought up to date" (`app_records_failed`) or "The forms and volunteer places of a student who moved to
    another family couldn't be brought up to date" (`follow_up_failed`). A refresh no longer does any of those, so none
    can happen again.) Press **Refresh** on the Roster page once. If a refresh that isn't Intuit's fails the same way
    again ("The roster couldn't be saved", `save_failed`), that is a fault in the portal for whoever maintains it.
  - "The roster was read from another QuickBooks company than the one connected now, so it wasn't read. Disconnect
    QuickBooks, then connect the company the roster was read from." (`roster_company`): the connection holds a different
    company from the one the portal's families came from, stored before the portal refused that (or by hand). Until
    families can be linked to another company's customers (the mapping screen, a later update), the portal reads only
    the company it read first, and asks QuickBooks nothing meanwhile; the roster and every family's records stay as
    they were. **Settings**, **QuickBooks**, open **Disconnect**, **Disconnect QuickBooks**, then **Change** and connect
    the first company again ([Reconnecting QuickBooks: The same company](quickbooks-reconnect.md#the-same-company)).
  - "The roster hasn't been refreshed from QuickBooks in more than 2 days": the worker isn't running (see Worker).
  - "The membership shape names a customer type QuickBooks no longer has": someone renamed or removed a customer type in
    QuickBooks. **Settings**, **QuickBooks**, **Change**, step 3: choose the shape again.
  - "Changes waiting for QuickBooks (staff roster changes and volunteer buy-out invoices): N waiting to reach
    QuickBooks": changes staff made, or buy-out invoices a guardian asked for, that QuickBooks couldn't take yet (it was
    busy or unreachable). They are tried again on their own, after 1, 5, 15 and 60 minutes, then every 6 hours.
    Nothing to do unless they stay.
  - "... stuck and waiting for someone to try them again or give them up on the Reconciliation page": a change failed
    8 times or for 24 hours, or QuickBooks may already have it. Open **Reconciliation** (the line's link). For each,
    look at the customer in QuickBooks, then **Try again now** if it isn't there, or **Give up** if it is (or isn't
    wanted any more). A stuck buy-out invoice: look in QuickBooks for an invoice whose private note reads "Booster
    Rocket buy-out" on that family or student. The **Volunteer buy-outs** list on the same page shows each buy-out
    that needs a look (an invoice QuickBooks no longer shows, one on another customer, a student who moved, one
    QuickBooks refused); the treasurer sorts those out in QuickBooks.
  - "N changes are kept in the portal that QuickBooks didn't take": a rename, or a student added to a family, was saved
    in the portal, and didn't go through to QuickBooks. Each row says who stopped it: QuickBooks refused it (the name
    is taken there, or it wouldn't take it), the portal held it back because QuickBooks has another name than the one
    the two last agreed on (someone renamed it there, or an earlier change was given up) or has the customer inactive,
    or the portal couldn't send it (QuickBooks wasn't connected, or needed an Admin to connect it again). The portal
    keeps its own value; QuickBooks keeps what it has. Open **Reconciliation** (the line's link): each change is under
    "Not in QuickBooks, kept in the portal", with why and what QuickBooks has now. Decide which is right: **Send the
    portal's value** to put the portal's in QuickBooks (it reads QuickBooks first, and sends nothing if the name there
    changed again since the page was shown), or **Give up** to leave QuickBooks as it is. Renaming the record again on
    its family's page takes the place of the kept change and is compared with the same agreed name, so after a taken
    name, or a change that couldn't be sent, that rename is sent (a taken name's row offers no **Send the portal's
    value**: rename it to a free name instead); after a name someone changed in QuickBooks it is held back again until
    someone presses **Send the portal's value**. Once a kept change is given up, a later rename is held back while the
    portal's name before it and QuickBooks' differ, and listed here with **Send the portal's value**. A row whose
    customer QuickBooks has inactive, or that isn't on the roster, offers no press: give it up.
  - That some of the portal's requests "didn't answer as the portal expects", the last time an Admin ran **Check the
    portal's requests** (the line's link; Settings, QuickBooks). QuickBooks answered one of the portal's requests in a
    way the portal wasn't written for. Open the page: each such row says what it found and what it means for the club.
    That is a change to the portal for whoever maintains it; send them a picture of the page. The check changes
    nothing in the portal by itself. The line says when the requests were last checked. "haven't been checked against
    a company yet", "didn't finish" or "some of the changes weren't tried" needs nothing urgent. On an installation
    connected to the club's real books, run the check there when convenient (Settings, QuickBooks, **Check the portal's
    requests**): against the real books it only reads. The checks that make changes are run on a separate installation
    connected to an Intuit sandbox company, such as the proof-of-concept host, never by switching this installation's
    company. Until the mapping screen ships, the portal refuses a company other than the one its families were read
    from anyway: see [Reconnecting QuickBooks: Connecting a different
    company](quickbooks-reconnect.md#connecting-a-different-company).

## Every family's invoices

- **"Not running"** while QuickBooks isn't connected: it waits. Fix the QuickBooks line first.
- **"The last read of every family's invoices stopped part way."** It carries on 15 minutes later. The note says why it
  stopped; if it keeps stopping, look at the QuickBooks line.
- **"... finished more than 2 days ago."** It should run daily: check the worker line.

## Buy-out invoices

The check of each volunteer buy-out's invoice that follows the daily read of every family's invoices: a paid one is
marked paid, and one QuickBooks no longer shows, or shows on another customer, or whose student QuickBooks no longer
holds under the family, is flagged for the club.

- **"Not running"** while QuickBooks isn't connected, and **"Not yet run"** before the first daily read: nothing to do.
- **"The last check of the buy-out invoices stopped with an error."** The worker tries again a minute later. If it
  keeps saying so, look at `docker compose logs worker` and the worker line.
- **"... haven't been checked against it."** A read of every family finished more than 15 minutes ago and the check
  didn't follow it: the worker isn't running, or stopped part way through its wake. See the worker line.
- **"N buy-out invoices are flagged and waiting for the club."** Open **Reconciliation** (the line's link): each
  flagged buy-out names its family, requirement and amount. The treasurer looks in QuickBooks for an invoice whose
  private note reads "Booster Rocket buy-out". For a student QuickBooks holds under another family, or inactive, put
  the student back in QuickBooks if that was a mistake, or void the invoice there and close the buy-out. The flag goes
  by itself once a later check finds the invoice where it belongs, its student back under the family.

## Outgoing mail

- **"Not set up"** or **"Not tested."** Parents can't sign in: they can't get password links or sign-in codes. **Settings**, **Outgoing mail**: save the
  settings and **Send test email** ([outgoing mail](mail.md)).
- **"Tested, but the last email failed."** Until a send works again, parents aren't sent sign-in codes, password links or welcome emails. The note has the mail service's reason. The usual ones: a changed or expired
  password (enter it again under **Outgoing mail**); for Microsoft 365, the mailbox renamed, or the app's permission removed
  (run the mail script again, [outgoing mail](mail.md#the-portal-microsoft-365)). Send a test email after the fix.

## Volunteer reminders

The emails the worker sends the day before each volunteer shift, and 14 and 3 days before a volunteer due date, from
9:00 on the club's clock.

- **"Off"**: parent sign-ins are off, so no reminder goes. **"Waiting for mail"**: outgoing mail isn't set up and
  tested yet; see the Outgoing mail line.
- A note that **the nudges before a volunteer due date wait until welcome emails are switched on**: by choice.
  **Settings**, **Parent sign-ins** switches welcome emails on when the club is ready to email families.
- **"N volunteer reminders couldn't be sent at the last try."** Each is tried again after 15 minutes while it is still
  the day for it. Look at the Outgoing mail line, which has the mail service's reason. The line keeps saying so until
  a reminder goes through.
- **"The last try to send volunteer reminders stopped with an error."** The worker tries again a minute later. If it
  keeps saying so, look at `docker compose logs worker`.

## Forms (Documenso)

- **"Not set up."** Parents read that forms aren't ready; nothing else is affected. [Documenso](documenso.md).
- **"Not checked."** Saved, but no call has worked yet: **Settings**, **Forms (Documenso)**, **Change**, **Check the
  connection**.
- **"The last call to Documenso failed."** Parents can't open a form to sign. The note gives the reason in words:
  - "couldn't be reached" or "took too long": `docker compose ps` (is `documenso` `healthy`?), then
    `<DOCUMENSO_URL>/api/health` from a browser. If both look fine, the machine can't reach its own address: run the
    two checks in [the first installation, step 5, item 5](first-install.md#5-the-first-start);
  - "refused the API token": the token was deleted, or the forms account was removed or disabled in Documenso. Make a
    new token as the forms account and paste it under **Settings**, **Forms (Documenso)**.
- **"The saved API token can't be opened with this server's encryption key."** `SETTINGS_ENCRYPTION_KEY` in
  `deploy/.env` isn't the one the token was saved with (often after a restore). Put back the right key, or enter the
  token again under **Settings**, **Forms (Documenso)**.
- **"... signed forms are waiting too long to be finished"**, with the note "signed by everyone more than an hour ago
  and Documenso still hasn't finished the signed copy". Documenso seals a form after the last signature, in the
  background. Check `<DOCUMENSO_URL>/api/health`: a certificate problem shows there (the file or passphrase in `.env`
  doesn't match, or the certificate expired: [renewing it](documenso.md#renewing-it)). If a timestamp service is set
  (`DOCUMENSO_TIMESTAMP_AUTHORITY`), it may be down.
- **"Evidence waiting: N signed forms haven't had the signed copy and its record kept yet."** Normal for a few minutes
  after a form is completed: the worker fetches the sealed PDF, certificate and audit log a few at a time.
- **"... waited more than an hour for the signed copy to be kept."** The worker can't fetch them: check that Documenso
  answers (the line above) and that the worker runs.
- **"... signed forms can't be filed while QuickBooks is connected to a company other than the one the roster was read
  from"**, with the note "N signed forms can't be filed yet". Not a Documenso problem: while QuickBooks is connected to
  another company the portal can't look up which QuickBooks customers a form was signed for, so it keeps nothing and
  asks Documenso nothing for it. The portal refuses to connect another company today, so this should never show: if it
  does, report it. Open **Settings**, **QuickBooks**: disconnect, and connect the company the roster was read from (the
  QuickBooks line on this page). The form stays signed in Documenso. The worker tries again on its own schedule, which
  after a few failed tries is every three hours, so the line can stay for up to that long after the right company is
  connected: it counts by each form's last try. A family or student with no QuickBooks link is no warning: its signed
  form is kept like any other, with no QuickBooks number.
- **"... came back from Documenso with a different file than the one kept."** The portal keeps the first copy and
  wrote `forms.evidence.mismatch` in the audit log. Tell the board: a signed document should never change. Keep the
  backups from before that date.
- **"No webhook secret is made"**: Documenso can't tell the portal at once when a form is signed; the portal still asks
  every few minutes. Make one under **Settings**, **Forms (Documenso)** and paste it into Documenso's team webhooks
  ([Documenso, part 3](documenso.md#3-connect-documenso-to-the-portal)).
- **"N form requirements of the current season have no template attached"**: attach one on each requirement's page.

## Parent sign-ins

- **"Off"**. No parent can sign in, not even a guardian staff have just added: the parent door stays closed until an
  Admin switches sign-ins on. It is a choice: **Settings**, **Parent sign-ins** switches them on (once outgoing mail works: QuickBooks plays no part in who can sign in). Reconnecting the same
  QuickBooks company leaves them as they are; a different company can't be connected until the mapping screen ships.
- **"Needs attention"**, with "The latest sign-ins have no address: the proxy in front of the portal doesn't send the
  header ...". `CLIENT_IP_HEADER` in `deploy/.env` names a header your proxy doesn't set. Find the one it does set
  ([a proxy of your own](first-install.md#a-proxy-of-your-own)), put it in `.env`, and `docker compose up -d app`.
  With this installation's own proxy it is `x-forwarded-for`.
- **"Needs attention"**, with "Welcome emails are waiting because mail is failing: ...". The last welcome email (or
  link to choose a password) the worker tried to send failed, so until one goes it tries one person a minute instead of
  five, and the people counted wait their turn. Mend the mail first: the [Outgoing mail](#outgoing-mail) line, and
  [outgoing mail](mail.md). The first welcome that goes clears it, and the rest go out five a minute again. Only
  people who can sign in now are counted. One address the mail server refuses (a mailbox that doesn't exist) is not
  mail failing and never shows this: the others still go, and that person's `parent.welcome.failed` row in the audit
  log says `recipientRefused`. Check the address with the family.

## Password breach check

When a parent chooses a password from a set-up or reset link, the portal asks Have I Been Pwned's Pwned Passwords
service whether it has appeared in a known data breach. Only the first five characters of a hash of the password leave
the server; the password itself never does.

- **"Not used yet."** No parent has chosen a password yet. Normal until the club starts sending set-up links.
- **"Needs attention"**, with "The Pwned Passwords service didn't answer the last time a parent chose a password". The
  passwords chosen since then were taken without the check: the portal never stops a parent for it, and each one's
  audit row says it wasn't checked. The note says why: no answer within 3 seconds, the service couldn't be reached, or
  its answer couldn't be read. The server must be able to reach `https://api.pwnedpasswords.com` over HTTPS. To try
  it from the portal's own container:

  ```sh
  docker compose exec app node -e "fetch('https://api.pwnedpasswords.com/range/00000').then(r => console.log(r.status), e => console.log(e.cause?.code ?? e.message))"
  ```

  `200` means it can. Anything else names what stopped it: look at the server's firewall and its outgoing connections.
  The line says **"Working"** again once a parent chooses a password and the service answers.

## Payment and checklist reminders

- **"Off."** Families are emailed 14 days and 3 days before a required payment or checklist item is due only while
  parent sign-ins and welcome emails are both switched on: **Settings**, **Parent sign-ins**. It is a choice, the
  Admin's sign that the club is ready to email families.
- **"Waiting for mail"**: outgoing mail isn't set up and tested, so no reminder goes; see the Outgoing mail line.
- **"It hasn't looked yet."** Normal on a new installation, or before 9:00 club time on the first day: the worker looks
  each day from then. If it stays that way, check the worker line.
- **"The last reminder email couldn't be sent."** The worker tries it again 15 minutes later, while it is still the day
  to send it. Look at the outgoing mail line: its note has the mail service's reason.
- A payment's reminder says the amount only from figures QuickBooks gave within the last few minutes, so most say
  "Not paid yet" and point to the Payments page. No reminder goes for a payment whose figures are more than 2 days old,
  or that has no invoice yet: check the "Every family's invoices" line if families say they weren't reminded.

## Last backup

- **"None recorded."** No backup has reached the portal. `docker compose ps` should show `backup` as `Up`, and
  `docker compose logs backup` its nightly lines. Take one now: `docker compose run --rm backup --now`
  ([backups](backups.md)).
- **"Needs attention"**, "The last backup is more than 2 days old." The nightly backup stopped working:
  `docker compose logs backup` has the reason (exit code 3, a database didn't answer; 2, the folder or a setting is
  wrong; 4, the backup failed and nothing was kept). If the host's own scheduler runs the backups, check its log.
- **"Documenso's database wasn't part of this backup"**: the backup ran without Documenso's database. With this
  installation that means `BR_DOCUMENSO_DB_NAME` was changed, or the backup ran from somewhere else; with forms signed in
  Documenso, put it back so both are backed up.

## Version

- Says which version is running and the commit it was built from. After an update it should name the new version
  ([updates](updates.md)). "A development copy that was never built" means the portal isn't running from an image.
