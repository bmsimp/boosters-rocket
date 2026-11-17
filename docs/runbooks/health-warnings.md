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
    are still valid on the developer site, then reconnect.
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
  - That some of the portal's requests "didn't answer as the portal expects", the last time an Admin ran **Check the
    portal's requests** (the line's link; Settings, QuickBooks). QuickBooks answered one of the portal's requests in a
    way the portal wasn't written for. Open the page: each such row says what it found and what it means for the club.
    That is a change to the portal for whoever maintains it; send them a picture of the page. The check changes
    nothing in the portal by itself. The line says when the requests were last checked. "haven't been checked against
    a company yet" or "didn't finish" needs nothing urgent: when convenient, connect the Intuit sandbox company (not
    the club's real books), run the check, then reconnect the real company. Against the club's real books the check
    only reads.

## Every family's invoices

- **"Not running"** while QuickBooks isn't connected: it waits. Fix the QuickBooks line first.
- **"The last read of every family's invoices stopped part way."** It carries on 15 minutes later. The note says why it
  stopped; if it keeps stopping, look at the QuickBooks line.
- **"... finished more than 2 days ago."** It should run daily: check the worker line.

## Outgoing mail

- **"Not set up"** or **"Not tested."** Parents can't get sign-in codes. **Settings**, **Outgoing mail**: save the
  settings and **Send test email** ([outgoing mail](mail.md)).
- **"Tested, but the last email failed."** The note has the mail service's reason. The usual ones: a changed or expired
  password (enter it again under **Outgoing mail**); for Microsoft 365, the mailbox renamed, or the app's permission removed
  (run the mail script again, [outgoing mail](mail.md#the-portal-microsoft-365)). Send a test email after the fix.

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
- **"... came back from Documenso with a different file than the one kept."** The portal keeps the first copy and
  wrote `forms.evidence.mismatch` in the audit log. Tell the board: a signed document should never change. Keep the
  backups from before that date.
- **"No webhook secret is made"**: Documenso can't tell the portal at once when a form is signed; the portal still asks
  every few minutes. Make one under **Settings**, **Forms (Documenso)** and paste it into Documenso's team webhooks
  ([Documenso, part 3](documenso.md#3-connect-documenso-to-the-portal)).
- **"N form requirements of the current season have no template attached"**: attach one on each requirement's page.

## Parent sign-ins

- **"Off"** / **"Not switched on yet."** No parent can sign in. It is a choice: **Settings**, **Parent sign-ins**
  switches them on (once QuickBooks and mail work). Connecting a different QuickBooks company switches them off.
- **"Needs attention"**, with "The latest sign-ins have no address: the proxy in front of the portal doesn't send the
  header ...". `CLIENT_IP_HEADER` in `deploy/.env` names a header your proxy doesn't set. Find the one it does set
  ([a proxy of your own](first-install.md#a-proxy-of-your-own)), put it in `.env`, and `docker compose up -d app`.
  With this installation's own proxy it is `x-forwarded-for`.

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
