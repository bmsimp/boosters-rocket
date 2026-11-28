# Boosters Rocket proof of concept on linuxdev: runbook

Follow this top to bottom, with one exception: the `/setup` page only exists after the first deploy (section 8).
Sign-in and outgoing mail are set up on the setup page after the first deploy (sections 3 and 4); a site that already finished setup uses "Upgrading a site that already finished setup" in section 4 instead. Each section is numbered steps. Anything in `monospace` is typed or
pasted exactly. Dashboard click paths were checked against Microsoft Learn and Cloudflare's
documentation on 2026-11-08; the sources are listed under each section. The outgoing-mail steps (section 4)
were added after that and were first walked through on 2026-11-10, on a site that had already finished setup
(section 11). If a screen no longer matches,
trust the screen and note it in the Results table.

**Since 2026-11-16 the staff menu is grouped, and every setting is under Settings.** Where this runbook says **Mail**,
**Sign-in**, **QuickBooks** or **Parent sign-ins** "in the staff menu", open **Settings** in the staff menu, then that
part's box (**Outgoing mail**, **Staff sign-in**, **QuickBooks**, **Parent sign-ins**) and its **Configure**.
**Audit** is under **Admin**. The setup page now asks for the club first, so its steps are one later than written below:
outgoing mail is Step 3 and the first Admin Step 4. The checks still to make before families use the portal, this
host's among them, are in [before the first family](before-the-first-family.md).

## 1. What this is

This puts Boosters Rocket on the Linux host `linuxdev` at https://portaltest.rhinoautomator.com, behind
a Cloudflare tunnel (and, optionally, Cloudflare Access), so you can prove that staff sign-in (the band's Entra
tenant or Google), parent sign-in (a password, with a 6-digit code the portal emails from
`webmaster@fznband.org` as a second step on a device it doesn't remember) and the audit log work for real. It also proves that the portal can connect to a
QuickBooks company (Intuit's sandbox, for this proof of concept), keep that connection alive with a worker, and show
staff the club's families as QuickBooks lists them. It holds **test data
only**; no real families use it.

Two sign-in doors exist. Staff use `/staff/sign-in`; parents use `/sign-in`. If Cloudflare
Access is set up, it sits in front of both, so testers sign in twice (an emailed code, then the portal's own
sign-in). For this proof of concept the owner chose to skip Access rather than manage a list of tester
emails (see section 7 B, which is optional), so testers sign in once, at the portal's own sign-in.

Sign-in is not configured in files. After the first deploy you open `/setup`, enter a one-time setup
code that `deploy.sh` prints, and set up staff sign-in, outgoing mail and the first Admin on that page
(sections 3 and 4).

## 2. First-time setup on linuxdev

Do this over SSH as user `brian`.

1. Get the code:
   ```bash
   git clone git@github.com:bmsimp/booster-rocket.git ~/booster-rocket
   cd ~/booster-rocket
   ```
2. Run the setup script. It creates the Docker network `booster-rocket-edge` and a private `.env.poc`
   file with freshly generated `BETTER_AUTH_SECRET`, `DB_PASSWORD` and `SETTINGS_ENCRYPTION_KEY`:
   ```bash
   scripts/poc/setup.sh https://portaltest.rhinoautomator.com
   ```
   The address is the one people will use for the portal; the script writes it into `.env.poc` as `APP_URL`.
   It is safe to run again, with or without the address; it never overwrites an existing `.env.poc`. (If an older `.env.poc` has no
   `SETTINGS_ENCRYPTION_KEY`, it adds one and leaves everything else alone.) `.env.poc` holds no
   Microsoft or Google values; those are entered on the setup page and stored encrypted in the
   database. **Back up `.env.poc` along with the database**: `SETTINGS_ENCRYPTION_KEY` is needed to read
   the stored sign-in secrets.
3. Let the tunnel container reach the app. Edit `~/n8n/docker-compose.yml`:
   - In the `cloudflared` service, add `booster-rocket-edge` to its `networks:` list, next to the
     networks already there (for example `cipp-tracker-net`):
     ```yaml
         networks:
           - cipp-tracker-net      # keep whatever is already listed
           - booster-rocket-edge   # add this line
     ```
   - In the top-level `networks:` section at the bottom of the file, add:
     ```yaml
     networks:
       booster-rocket-edge:
         external: true
     ```
     (Keep the other entries already there, for example `cipp-tracker-net`.)

   This goes in the n8n file, not a Boosters Rocket file, because the weekly cron script that updates
   cloudflared recreates it from that file and would otherwise drop the connection.
   The edit adds `booster-rocket-edge` to the `networks:` list cloudflared already has, and to the
   top-level `networks:` as external.

   **Never run `docker image prune -a` on this host**: it would delete the unused
   `booster-rocket-app:previous` rollback image. Plain `docker image prune` (dangling images only) is fine.
4. **Pick a quiet time, then recreate cloudflared.** Recreating it briefly drops *every* site on this
   tunnel (n8n, the CIPP tracker, and anything else), usually for a few seconds to a minute.
   ```bash
   docker compose -f ~/n8n/docker-compose.yml up -d --no-deps cloudflared
   ```
5. Confirm the tunnel reconnected (you should see several lines):
   ```bash
   docker logs cloudflared 2>&1 | grep "Registered tunnel connection"
   ```
   If nothing prints, wait 30 seconds and try again. If still nothing, run `docker logs --tail 50 cloudflared`
   and check the edit in step 3.
6. Make sure the file is private (the deploy script refuses otherwise): `ls -l ~/booster-rocket/.env.poc`
   must start with `-rw-------`. If not: `chmod 600 ~/booster-rocket/.env.poc`.

**If you ever delete `.env.poc` and run `scripts/poc/setup.sh` again:** it generates a *new*
`DB_PASSWORD`, but the existing Postgres volume `booster-rocket-pgdata` still expects the *old* one, so
the app and the migration will fail to log in to the database. Fix it one of two ways:
- *Keep the data:* put the old `DB_PASSWORD` back into the new `.env.poc` (if you have a backup of
  the old file), including the old `SETTINGS_ENCRYPTION_KEY`. Without that key the stored sign-in
  secrets cannot be read; see the troubleshooting table.
- *Throw the data away (test data only):* stop the stack and delete the volume, then deploy again.
  ```bash
  cd ~/booster-rocket
  docker compose -f docker-compose.poc.yml --env-file .env.poc down
  docker volume rm booster-rocket-postgres booster-rocket-pgdata
  ```
  (`booster-rocket-postgres` is Postgres 18's data, `booster-rocket-pgdata` Postgres 16's from before the move; a
  volume that isn't there is reported and skipped.)
  Deploy again; the deploy prints a new setup code, and you go through the setup page (sections 3
  and 4) again. After the deploy, read the roster (section 5) and add the test parents again (section 6): the
  guardian rows are gone.

## 3. Staff sign-in (the band's Entra tenant, or Google)

Do this after the first deploy (section 8). Open https://portaltest.rhinoautomator.com/setup, enter the
setup code `deploy.sh` printed, and follow **Step 1** of the setup page. It walks you through Microsoft
(or Google) and checks what you paste before it saves it. Microsoft sign-in uses a certificate the app
makes for itself, not a client secret (the band's tenant blocks client secrets). For Microsoft you can
instead run the PowerShell script the page offers, `New-BoosterRocketStaffApp.ps1`, which creates the
registration and adds the certificate for you.

If the code has scrolled away or stopped working, get a new one on linuxdev:
```bash
cd ~/booster-rocket
scripts/poc/setup-code.sh
```

**What the setup page asks for (Microsoft).** Use an account in the band's Entra tenant that can register
applications (you are Global Administrator). Reference only; the page shows these steps as you go.

1. Sign in to https://entra.microsoft.com. If you have several tenants, use the **Settings** icon at the
   top and switch to the band's tenant.
2. Browse to **Entra ID** > **App registrations** and select **New registration**.
3. **Name:** `Booster Rocket (staff)`. Use exactly this name: the script finds the app by it.
4. **Supported account types:** choose **Single tenant only - <your tenant>**.
5. **Redirect URI:** set the platform to **Web** and enter exactly:
   ```
   https://portaltest.rhinoautomator.com/api/auth/staff/callback/microsoft
   ```
   (If you skip it here: open the app, under **Manage** select **Authentication**, **Add Redirect URI**,
   choose **Web**, enter the URI above, **Configure**.)
6. Select **Register**. On the **Overview** page copy:
   - **Application (client) ID**
   - **Directory (tenant) ID**. This must be the GUID (like `00aa00aa-bb11-cc22-dd33-44ee44ee44ee`),
     never the words `common`, `organizations` or `consumers`.
7. On the setup page, in the Microsoft card, select **Download certificate (.cer)**. It saves
   `booster-rocket-staff.cer`. In Entra, under **Manage** select **Certificates & secrets** >
   **Certificates** > **Upload certificate**, choose that file and add it. There is no secret to create,
   and no secret **Value** to copy.
8. Enter the tenant ID and client ID in Step 1 of the setup page and select **Check and save**. There is
   no expiry date to type for Microsoft.

**The script and the manual steps use the same names.** `New-BoosterRocketStaffApp.ps1` looks for an app
named `Booster Rocket (staff)` and reuses it, checking its settings, instead of creating a second one. If
you already did the steps above under that name, running the script is safe: it fixes the settings and adds
the certificate. It creates and prints no secret. It prints the **Tenant ID**, the **Client ID** and the
certificate's thumbprint and expiry; enter the tenant ID and client ID on the setup page. It keeps any
certificates already on the app. If Microsoft does not return them, or one has expired, the script stops
with a message to fix it by hand. (If two apps share the name it stops and asks you to delete the extra one.)

**Before running a downloaded script on Windows**, unblock it, or Windows may refuse to run it:
```powershell
Unblock-File .\New-BoosterRocketStaffApp.ps1
```

After setup, Admins can change sign-in under **Settings** > **Sign-in**. **Replace certificate** makes a
new certificate; **Download certificate (.cer)** then downloads it, and you upload it in Entra. The old one
keeps working until **Check and switch** succeeds; after that you can remove the old certificate in Entra
(**Certificates & secrets** > **Certificates**). To drop a replacement you no longer want, select
**Discard replacement** (if you already uploaded it, remove it in Entra too). **Replace certificate** also
works on the setup page after `scripts/poc/reopen-setup.sh`, for example when the server can no longer read
the old certificate's key. The staff home warns Admins 30 days before a certificate expires; use Replace
certificate under **Sign-in** in the staff menu. (Google still uses a client secret, entered as before.)

Sources: Register an application in Microsoft Entra ID
(https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app); Add a redirect URI
(https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri); Add credentials,
including certificates
(https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).

## 4. Outgoing mail (Microsoft 365, sending as webmaster@fznband.org)

Parents sign in with a password, chosen from a link the portal emails them, and on a device the portal doesn't
remember yet with a code it emails them too, so mail must work before any parent can sign in. The portal
sends as one mailbox, `webmaster@fznband.org`, through Microsoft Graph with the staff app's certificate. Exchange
Online only lets the app send as that mailbox. (The portal can send through SMTP instead; this section covers
Microsoft 365.)

The script's mail part first ran against the band's tenant on 2026-11-10 (section 11 has what happened). It has
not been run on the setup page of a new site, only from **Mail** on a site that had finished setup.

1. Do section 3 first: this uses the staff app.
2. On a Windows PC with PowerShell 7, install the Exchange Online module once:
   `Install-Module ExchangeOnlineManagement -Scope CurrentUser`
3. On the setup page, Step 2 (Outgoing mail), follow the numbered steps under **Microsoft 365: let the app send as
   one mailbox** (the page fills in the band's tenant ID for you): download
   `New-BoosterRocketStaffApp.ps1` again (it carries the current certificate), run `Unblock-File` on it, then run
   `./New-BoosterRocketStaffApp.ps1 -TenantId <band tenant ID> -SetUpMail -Mailbox webmaster@fznband.org`, signed in
   as an Exchange administrator. It reuses the staff app and adds the mail permission. (The same steps by hand are
   under that heading on the setup page.) The script:
   - needs `-Mailbox` to be an email address, and stops if Exchange Online has no such mailbox;
   - asks you to sign in to Exchange Online, and stops if you sign in to a different tenant from the one you gave
     with `-TenantId` (run it again and sign in as an administrator of the band's tenant);
   - creates a management scope named `Booster Rocket mail sender` that holds only that mailbox (matched by its
     primary address), and gives the app the `Application Mail.Send` role on that scope;
   - stops with "The app has more than one 'Application Mail.Send' role assignment in Exchange Online" and names them.
     Remove the extras in Exchange Online, then run it again;
   - checks that every Exchange Online assignment that lets the app send mail is limited to that scope. If it finds
     others, it stops and names them. It never removes anything itself: remove the extras in Exchange Online (the
     message gives the command that lists them), then run it again;
   - stops with "The app could send as more than webmaster@fznband.org or as no one: Exchange does not report any
     sending permission for the app" if, after it made the assignment, Exchange Online reports no permission for the
     app to send at all. Check the app's assignments with the command the message gives, then run it again;
   - stops with "the role assignment is in place, but Exchange doesn't report the mailbox in scope" if the mailbox
     isn't in scope yet. Check the address and run it again.
4. If the script stops because the app holds Microsoft Graph's **Mail.Send** application permission in Entra, do what
   it says (Enterprise applications > the app > Permissions, **Revoke permission**, and remove **Mail.Send** from
   the app registration's API permissions), then run it again. That permission would let the app send as anyone.
5. When it ends with "The app can now send as webmaster@fznband.org, and only as webmaster@fznband.org", wait 30
   minutes to 2 hours: Microsoft caches app permissions for that long.
6. On the setup page choose **Microsoft 365**, enter `webmaster@fznband.org`, **Save**, then **Send test email** to
   an address you can read. When it arrives, **Next: first Admin** turns on. Until a test email has gone out, the
   first Admin step (`/setup?step=admin`) and finishing setup are blocked too.

### Upgrading a site that already finished setup

Setup on linuxdev finished on 2026-11-09, so `/setup` answers "not found" there and steps 3 and 6 above can't
happen on the setup page. Do this instead:

1. **Before you deploy, back up the database.** The deploy changes the parent tables, and the backup is your only way
   back (step 5). On linuxdev:
   ```bash
   cd ~/booster-rocket
   docker compose -f docker-compose.poc.yml --env-file .env.poc exec -T db pg_dump -U booster -d booster > ~/booster-rocket-before-parent-codes.sql
   ```
   The file goes in your home folder, not the checkout (a file in the checkout makes `deploy.sh` refuse, exit 2).
   Keep a copy of `.env.poc` with it (section 2).
2. Deploy (section 8). The migration runs as part of the deploy:
   - every guardian row already in the database becomes a person with that family. Rows with the same email
     (trimmed and lowercased) become one person, named from the oldest row. A disabled row stays disabled, as removed.
     Where one person then has more than one row for the same family, only one is kept and the others are deleted:
     an enabled row before a disabled one, then the primary one, then the oldest;
   - every earlier parent sign-in account is deleted, and its sessions with it, so anyone signed in as a parent is
     signed out. Each person gets a new sign-in account for the email code;
   - the parents tenant's sign-in settings and certificate are removed from the portal.
3. Sign in at `/staff/sign-in` and choose **Mail** in the staff menu (Admins only). It has the same card as Step 2 of
   the setup page: the numbered steps under **Microsoft 365: let the app send as one mailbox**, with the script download, then **Save** and
   **Send test email**. Do steps 2 to 6 above there instead of on the setup page (step 6's first Admin part is
   setup only; skip it).
4. Until a test email has gone out, `/sign-in` says "Parent sign-in isn't available yet." and the staff home shows
   a warning.
5. **Rolling back.** `scripts/poc/deploy.sh --rollback` (section 8) doesn't undo the migration, and the previous image's
   code doesn't match the new parent tables, so expect errors on it wherever parents are involved. To go back, put the backup from
   step 1 in place first, then roll back:
   ```bash
   cd ~/booster-rocket
   docker stop booster-rocket-app
   docker compose -f docker-compose.poc.yml --env-file .env.poc exec db dropdb -U booster booster
   docker compose -f docker-compose.poc.yml --env-file .env.poc exec db createdb -U booster booster
   docker compose -f docker-compose.poc.yml --env-file .env.poc exec -T db psql -U booster -d booster < ~/booster-rocket-before-parent-codes.sql
   scripts/poc/deploy.sh --rollback
   ```
   This throws away everything done since the backup, including the audit log rows. These restore steps haven't been
   tried on linuxdev yet.

The old parents tenant (`fznbandparents`) and its app aren't used any more. Delete them whenever you like; the
portal never deletes anything in a tenant, and nothing here does it for you.

Sources: Role Based Access Control for Applications in Exchange Online
(https://learn.microsoft.com/exchange/permissions-exo/application-rbac); user: sendMail
(https://learn.microsoft.com/graph/api/user-sendmail).

## 5. QuickBooks (an Intuit sandbox company)

The portal reads the club's families from QuickBooks. For this proof of concept it connects to an Intuit sandbox
company, a test company that holds no real books. The checks below were made on 2026-11-11, when the portal wrote
nothing to QuickBooks. It now writes what someone asks it to: a parent's own phone, address and sign-in email, the
roster changes staff make, and a volunteer buy-out's invoice (`QUICKBOOKS_USE` in
`src/lib/quickbooks/what-it-does.ts` says it in the words the QuickBooks page shows). A worker container keeps the connection alive. These steps were walked through on 2026-11-11 (section 11). Do them after the first deploy (section 8) and after
section 3, because they use the staff app. Deploy this version (the one with the worker) first, before step 1.

1. In the Intuit developer app, under **Settings** > **Redirect URIs** > **Development**, add the redirect address
   `https://portaltest.rhinoautomator.com/api/quickbooks/callback` exactly. (The keys are on a different page,
   **Keys and credentials**.)
2. In the sandbox company, make sure the customer types exist (**Sales** > **Customers** > **Customer types**): the
   band's are `Family`, `Parent`, `Student`, `School` and `Vendor`, with students and parents as sub-customers of a family.
3. Sign in at `/staff/sign-in` and choose **QuickBooks** in the staff menu (Admins only), then **Configure**.
4. Step 1: enter the Development **Client ID** and **Client secret**, choose **Sandbox**, **Save**.
5. Step 2: **Connect to QuickBooks**, sign in to Intuit, choose the sandbox company, **Connect**. You come back to step 3.
6. Step 3: choose **Layered**, `Family` for the family, `Student` for the student, `Parent` for the parent,
   **Preview**, check the counts and names, then **Save this shape**.
7. Choose **Roster** in the staff menu: the families are listed, and **Needs attention** shows what to tidy up.
8. The worker: `docker ps --filter name=booster-rocket-worker` shows it running, and
   `docker logs booster-rocket-worker` shows `worker started` and a line each time it runs a job. The QuickBooks page
   shows when it last checked in. On the first deploy that includes the worker, `docker ps --filter name=booster-rocket-worker`
   may show nothing: `deploy.sh` updates itself during its own `git pull`, so that run is still the old copy, which
   recreates only the app. Run `scripts/poc/deploy.sh` once more (or
   `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d worker`); every deploy after that starts it.
   The backup service is the same: the first deploy that includes it may leave it out, and
   `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d backup` starts it.

**Switching companies.** A QuickBooks company other than the one the roster was read from is connected only as a
switch: **Disconnect**, then **Connect a different company** (on the QuickBooks page, or in step 2), which lists what a
switch ends and keeps, then its checkbox and **Switch companies: sign in to Intuit**
([reconnecting QuickBooks](quickbooks-reconnect.md#connecting-a-different-company)). The families, students and
guardians stay, unlinked, to be linked again on **Accounting links**; sessions and welcomes survive, and the audit log
has no `parent.access.cleared`; each family's money reads as not connected until it is linked; unpaid buy-outs end and
are listed on **Reconciliation**, and paid ones keep counting; every requirement's product or service is chosen again
from the new company's list on its season, since until then no family is offered to pay instead of volunteering.
Going back to the first company is a second switch. With
no switch asked for, step 2 says "That is a different QuickBooks company from the one the portal's families were read
from", nothing is stored, and a connection to another company stored by hand stops the roster refresh
(`roster_company`). Reconnecting the same company works as before. The club's real books go on an installation of
their own, never this host.

The worker is verified to keep running with no input attached and to stop cleanly on `docker stop` (exit code 0,
`worker stopped` in its log). That was checked on linuxdev on 2026-11-11 with the script alone in a `node:26-slim`
container. As the compose service there it ran with no restarts through the 2026-11-11 walkthrough and renewed the
connection (`ran quickbooks.token_refresh: ok`).

Moving to the band's real books later means the app's **Production** keys, **Production** in step 1, and Intuit's app
assessment first.

### Parent sign-ins

Since stage 3 of the app-owned families work (slice 7a), who can sign in is the portal's own list of each family's
guardians: a Parent customer in QuickBooks gives nobody a sign-in, and a change in QuickBooks ends none. The guardians
are the ones the portal already holds (on this host, anyone the earlier version gave a sign-in from QuickBooks, who
keeps it), and those staff add in the portal (the test parents of section 6): on a family's page under
**Families**, the **Portal sign-ins** box, **Add guardian** (nothing is sent to QuickBooks for them). Nobody signs in
until parent sign-ins are switched on, however they came to be a guardian. Switching on needs only working mail.

1. Choose **Parent sign-ins** in the staff menu (Admins only), then **Configure**.
2. **Step 1: Parent sign-ins**: it says how many people could sign in, to how many families. **Switch parent sign-ins
   on**. The step then says "Parent sign-ins are on." with the same counts. No email is sent, and no guardian row is
   opened or closed.
3. In a private window, sign in as a test parent at `/sign-in` with their email and the password they chose, and on
   a browser the portal doesn't know yet the code it then emails. A tester with no password chooses one first, from
   the link in their welcome email or from **Set up or reset my password** on the sign-in page.
4. **Next: welcome emails** (step 2), then **Switch welcome emails on**. Within a minute or two each guardian who has
   never been welcomed gets the welcome email, with a link to choose a password if they have none (it works once, for
   7 days). The testers this host welcomed before the sign-in release have no password and are not welcomed again by
   themselves: back on **Parent sign-ins**, **Email a set-up link to everyone who can sign in and hasn't chosen a
   password** emails each of them a link to choose their password ("Choose your password for" the club). A tester who
   already holds a set-up link that still works is welcomed with no new link: their welcome says the one emailed
   earlier still works.

Switching parent sign-ins **off** (step 1, **Switch parent sign-ins off**) signs every parent out at once, and also
switches welcome emails off. Switching sign-ins on again does not switch welcomes back on: do step 2 again.

**Parents** in the staff menu (needs the Parents permission; Admin has it) lists every person and each family they
belong to, with block, unblock and resend welcome on each person's page. A sign-in that an earlier version closed for
something QuickBooks held (an address under two families, an inactive record) stays closed, with its reason in words.

## 6. Test parents

1. **After the roster has been read** (section 5, steps 1 to 7: QuickBooks connected and the shape saved), add parent
   one as a guardian of a real sandbox family. Sign in at `/staff/sign-in`, choose **Roster** under **Families**, open a
   family, and in its **Portal sign-ins** box, under **Add a guardian**, enter the tester's name and an address you can
   read, then **Add guardian** (it takes the permission to change families; Admin has it). The box answers "Added ..."
   and lists them as able to sign in. If the address already belongs to someone in the portal, nothing is changed yet:
   the box says who that is and which families they are a guardian of, and **Yes, add them** adds that same person.
   For a tester in two families (check 21), add the same address on a second family's page; the sandbox company starts
   with one family, so first make another (**Make a family** on the roster page, then add a student to it).
   Nothing is sent to QuickBooks for a guardian. Every add is in the audit log (`parent.create` for a new person,
   `parent.access.granted`), with who made it.
2. The tester can't sign in until parent sign-ins are switched on (section 5, "Parent sign-ins"): the parent door is
   closed until an Admin switches them on, however the guardian came to be. A guardian is let in only through a family
   the portal holds from the roster, so a tester is always added on a family the roster has read, never by hand.
3. Parent two is any other address you can read. It gets no guardian row on purpose (checklist step 7).

The testers an earlier version seeded by hand on `POC-FAMILY-1` and `POC-FAMILY-2` (a script since removed) were
never QuickBooks customers: a roster read by a version from before stage 3's slice 9c gives their family a record of
the portal's own, held as inactive, so they can't sign in. Add the testers again as above. Before deploying an update
that brings migration 0037, read the roster with the version the host runs now (**Refresh now** on the staff roster
page; reconnect QuickBooks first if it is disconnected): that version's read still gives every open guardian row its
family record, and an update that finds an open row with none, in a portal whose roster names a company, stops and
changes nothing ("Migration 0037 stopped"). Read the roster, then deploy again. From stage 3's slice 9c on, a roster
read gives no row a family and changes no record: a tester added on a family's page has their family from the start.

Adding a guardian sends no welcome email unless welcome emails are on; otherwise tell the parent to go to
`/sign-in/password` (**Set up or reset my password** on the sign-in page) for a link to choose a password, or send
the welcome from their page under **Parents**. Like every guardian's, the sign-in lets the tester in only while parent sign-ins are on, and
nothing in QuickBooks ends it. **Remove** beside them in the same box ends it, with a note only staff see.

**Blocking a parent.** Choose **Parents** in the staff menu, open the person, enter a reason under
**Why? (staff only)** and choose **Block**; **Unblock** on the same page lets them sign in again with their password (the browsers the portal remembered
for them stay forgotten, so each asks for an emailed code again). Both are in the
audit log (`parent.block`, `parent.unblock`), and blocking signs the person out at once.

**Last resort, only if the staff pages are unavailable.** On linuxdev:
```bash
cd ~/booster-rocket
docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "update parent set blocked = true where email = '<address>';"
```
Use the address trimmed and lowercased, as the portal stores it. From then on their password is refused (the audit
shows `signin.password_refused`, reason `blocked`), a code they already have is refused when they enter it, and the next time they
open a portal page all their sessions end (`signin.refused`, reason `blocked`). Their family rows are left as they
were, so `update parent set blocked = false where email = '<address>';` gives back the same access. The SQL change
itself isn't in the audit log.

## 7. Cloudflare

Part A is required. Part B (Cloudflare Access) is **optional**: the owner skipped it for this proof of
concept rather than manage a list of tester emails.

Without Access, anyone who has the address can reach the portal's sign-in pages, which is acceptable only
because the site holds test data. Do whichever parts you need in the Cloudflare dashboard for the account that owns `rhinoautomator.com`.

**A. Route the hostname through the existing tunnel**

1. Go to **Networking** > **Tunnels** and select the tunnel that `cloudflared` on linuxdev uses.
2. On the **Routes** tab select **Add route**, then **Published application**.
3. **Subdomain:** `portaltest`. **Domain:** `rhinoautomator.com`. Leave path empty.
4. **Service URL:** `http://booster-rocket-app:3000`
5. Expand **Additional application settings** > **HTTP** and make sure **HTTP Host Header is left empty**.
   The app needs to see `portaltest.rhinoautomator.com` as the Host or sign-in and form posts fail.
6. Select **Add route**.

Sources: Create a tunnel / publish an application
(https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/);
HTTP Host Header location and default (empty)
(https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/).

**B. Put Cloudflare Access in front (optional; skipped for this proof of concept)**

1. Add the One-time PIN login method once (skip if already there): **Zero Trust** > **Integrations** >
   **Identity providers** > **Add new identity provider** > **One-time PIN**.
2. Create the policy: **Zero Trust** > **Access controls** > **Policies** > **Add a policy**. **Policy
   name:** `Boosters Rocket testers`. **Action:** **Allow**. Set a **Session duration**. Under **Rules**, add
   an **Include** rule with the **Emails** selector and enter each tester's email (the owner and the
   test parents). **Save**.
3. Create the application: **Zero Trust** > **Access controls** > **Applications** > **Create new
   application** > **Self-hosted and private**. Select **Add public hostname**, enter subdomain
   `portaltest` and domain `rhinoautomator.com`. Under **Access policies** add the existing
   `Boosters Rocket testers` policy. Under identity providers select **One-time PIN** (turn off
   others you do not want). Choose a **Session Duration**, then **Create**.
4. Check: open https://portaltest.rhinoautomator.com in a private window. You should be asked for an email
   and then get a code by email (10-minute expiry). An email *not* on the list gets no email, but the
   page still says a code was sent.

Sources: Self-hosted public application
(https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/);
Policies
(https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/); One-time
PIN (https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

## 8. Deploy

1. On linuxdev:
   ```bash
   cd ~/booster-rocket
   scripts/poc/deploy.sh
   ```
   It refuses if the checkout has local changes, pulls `main`, builds the image, backs up the database into
   `~/booster-rocket-backups` (or `BR_BACKUP_DIR`; `scripts/backup.sh`, keeping the newest 14), runs the database
   migrations, recreates the app and waits up to 120 seconds for it to become healthy, then starts the worker and the
   backup service. The first build takes several minutes. A worker that won't start doesn't fail the deploy: it prints
   "The worker didn't start. The site is up; check: docker logs booster-rocket-worker". Nor does the backup service:
   "The backup service didn't start. The site is up; check: docker logs booster-rocket-backup".
   On the first deploy that includes the worker, `docker ps --filter name=booster-rocket-worker` may show nothing:
   `deploy.sh` updates itself during its own `git pull`, so that run is still the old copy, which recreates only the
   app. Run `scripts/poc/deploy.sh` once more (or
   `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d worker`); every deploy after that starts it.
2. **Success** is the last line `Deployed <short commit>.` and exit code 0 (`echo $?`). Also:
   `docker ps --filter name=booster-rocket-app` shows `(healthy)`. While setup is still open, a line
   `Setup code: XXXX-XXXX-XXXX` is printed just before it. Enter that code at `/setup`. Once setup is
   finished, no code is printed.
3. If it stops, the exit code says why:

   | Code | Meaning | What to do |
   |---|---|---|
   | 2 | Refused: local changes, `.env.poc` missing, not mode 600 or without an `APP_URL` line, or another deploy is running; or the database must first be moved to a new Postgres (the message says so, and the running site was left alone) | Read the message; fix; run again. For the database: [Moving the database to Postgres 18](#moving-the-database-to-postgres-18) |
   | 3 | Migrations failed; running app untouched | Read the migrate output above the message; check `DB_PASSWORD` (end of section 2). If it says `dependency failed to start: container booster-rocket-db-1 is unhealthy` on the first deploy of the commit that moves to Postgres 18, the old copy of `deploy.sh` replaced the database before it found out: the site is down and the database refuses to start, and nothing is lost. Follow [Moving the database to Postgres 18](#moving-the-database-to-postgres-18) from step 4 |
   | 4 | App did not become healthy in time | `docker logs booster-rocket-app`; then `scripts/poc/deploy.sh --rollback` if needed |
   | 5 | Nothing to roll back to | None (nothing was changed) |
   | 6 | `git pull` failed | Check network and SSH key; nothing was changed |
   | 7 | Build failed; running app untouched | Read the build output |
   | 8 | The backup before the migrations failed; nothing migrated, running app untouched | Check the backup folder can be written by the deploying user (`BR_BACKUP_DIR`), and that the database container runs |
4. **Roll back** to the previous image (database changes are *not* undone):
   ```bash
   scripts/poc/deploy.sh --rollback
   ```
   Rolling back to a version from before the worker existed leaves a worker container that restarts in a loop (that
   image has no worker script). The site is unaffected; stop the worker with
   `docker compose -f docker-compose.poc.yml --env-file .env.poc stop worker`.
5. **Logs:** `docker logs booster-rocket-app` (add `--tail 100` or `-f`). Database:
   `docker compose -f docker-compose.poc.yml --env-file .env.poc logs db`. Backups: `docker logs booster-rocket-backup`.
6. **Backups.** The `backup` service runs `scripts/backup-agent.sh` as a club's installation does
   ([backups](backups.md)): the nightly backup at 03:00 club time, or the time saved on **Settings, Backups**, into
   `~/booster-rocket-backups` (or `BR_BACKUP_DIR`), and what that page asks for (back up now, a download, a restore).
   It replaces the nightly line `scripts/backup.sh "$HOME/booster-rocket-backups"` in `crontab -e`: once
   `docker ps --filter name=booster-rocket-backup` shows it `Up`, remove that line, or every night makes two backups.
   The proof of concept has no Documenso, so its backups hold the portal's database alone.
7. After the first successful deploy, finish setup at `/setup` (sections 3 and 4), connect QuickBooks and read the
   roster (section 5), then add the test parents (section 6).
8. **Need a code later?** `scripts/poc/setup-code.sh` prints a new one (the old code stops working) while
   setup is open. **Nobody can sign in** (for example, a certificate or Google client secret expired)?
   `scripts/poc/reopen-setup.sh` reopens setup and prints a code. Stored sign-in values are kept and
   existing Admins stay Admins.

### Moving the database to Postgres 18

The proof of concept ran Postgres 16, its data in the volume `booster-rocket-pgdata`. From the commit that moves it,
`docker-compose.poc.yml` runs Postgres 18 with its data in a new volume, `booster-rocket-postgres`, and mounts
`booster-rocket-pgdata` read only beside it. Until the data is moved, the database refuses to start (its log, and
`scripts/poc/deploy.sh`, say `Postgres was NOT started, and no data was changed or deleted` and name this section),
so the portal never starts on an empty database. The move only reads `booster-rocket-pgdata`, through a read-only
mount, to copy it, and leaves it exactly where it is: do not remove it. Never run the previous version, or a second
move, from another window while a move runs. Do these in order, on linuxdev, as the person who deploys:

1. See what runs now and how big the data is; the disk needs at least four times that free:
   ```bash
   cd ~/booster-rocket
   docker compose -f docker-compose.poc.yml --env-file .env.poc ps
   docker compose -f docker-compose.poc.yml --env-file .env.poc exec -T db psql -U booster -d booster -Atc "select version(), pg_size_pretty(pg_database_size('booster'))"
   df -h ~ /var/lib/docker
   ```
   The first line names `PostgreSQL 16`.
2. Back it up with Postgres 16, before anything changes:
   ```bash
   scripts/backup.sh ~/booster-rocket-backups
   ```
   It ends with the list of three more things to keep, after `Backup written: ...`.
3. Get the new files **by hand**, not with `deploy.sh`: the copy of `deploy.sh` on disk is the old one until this pull,
   and it would replace the running database before it found out.
   ```bash
   git pull --ff-only
   git log --oneline -1
   ```
   (If `scripts/poc/deploy.sh` was run first, it may have stopped with code 3, `Migrations failed`, and left the site
   down with the database refusing to start. Nothing is lost: carry on from step 4. If it stopped with code 2 or 8, the
   site is still up on Postgres 16, and nothing is lost either: carry on from step 4.)
4. Move the data:
   ```bash
   scripts/move-postgres.sh poc ~/booster-rocket-moving-to-postgres-18
   ```
   It stops the worker, the app and the database; copies `booster-rocket-pgdata` into a volume of its own
   (`booster-rocket-move-copy-16`, removed when it ends) and starts Postgres 16 on that copy, read only; counts every
   table's rows and backs the database up into `~/booster-rocket-moving-to-postgres-18`; starts Postgres 18 on
   `booster-rocket-postgres`, loads the backup and counts every table again. **Success** is the line
   `booster: <n> tables, every one with the same number of rows as before.` followed by
   `The move is done: Postgres 18 holds the data. ...`, `Now deploy, ...` naming step 5, and exit code 0 (`echo $?`).
   Any other ending says what went wrong: nothing is lost, and running the same command again starts again from the
   Postgres 16 data. If it stops at the start with `The Postgres 16 server also holds what the move doesn't carry`
   and names a database or role, nothing was changed: one left by trying a restore (`booster_restore_check`) isn't
   needed, so run the same command with `--leave-others` at the end; anything else, back it up with `pg_dump` first.
5. Deploy as usual (section 8, step 1), which builds, backs up with Postgres 18 into `~/booster-rocket-backups`,
   migrates and starts the app and the worker:
   ```bash
   scripts/poc/deploy.sh
   ```
   **Success** is `Deployed <short commit>.` and exit code 0.
6. Check:
   ```bash
   docker compose -f docker-compose.poc.yml --env-file .env.poc exec -T db psql -U booster -d booster -Atc "select version()"
   docker volume ls --filter name=booster-rocket-
   ```
   The first names `PostgreSQL 18`; the second lists both `booster-rocket-pgdata` (Postgres 16's data, kept) and
   `booster-rocket-postgres`. Then sign in as staff and open **Health** (every line as before), and open a test
   parent's Home (section 6).
7. Record the date, the commit and the row counts line in section 11. Leave `booster-rocket-pgdata` and
   `~/booster-rocket-moving-to-postgres-18` in place: removing them is the owner's decision, and going back needs them.

Going back to Postgres 16, while `booster-rocket-pgdata` is still there. Anything done in the portal since the move
is not in it: it stays in `booster-rocket-postgres` and in the Postgres 18 backups in `~/booster-rocket-backups`,
which Postgres 16 can't load (the previous version's `scripts/restore.sh` calls such a file "damaged"; it isn't).

1. `docker compose -f docker-compose.poc.yml --env-file .env.poc stop`
2. Always, even if no move was cut off (it stops whatever a move left behind and changes nothing else; it says
   `Nothing of a move was left here.` when there is nothing): `scripts/move-postgres.sh poc --stop`
3. Copy the Postgres 18 backups aside, before Postgres 16's deploys (which keep the newest 14 in the same folder)
   remove them: `mkdir -p ~/booster-rocket-postgres-18-backups && cp -p ~/booster-rocket-backups/*.dump ~/booster-rocket-postgres-18-backups/`
4. `git log --oneline` and `git checkout <the commit before the move>`.
5. Build that commit's portal and start it on Postgres 16. Not `scripts/poc/deploy.sh --rollback`: the move stopped
   the app, so the deploy in the move's step 5 kept no copy of the image that ran on Postgres 16, and the one
   `--rollback` holds is older still.
   ```bash
   APP_COMMIT="$(git rev-parse --short HEAD)" docker compose -f docker-compose.poc.yml --env-file .env.poc build app
   docker compose -f docker-compose.poc.yml --env-file .env.poc up -d db app worker
   ```

To come forward again: `git checkout main`, then step 4 of the move with `--again` at the end. It first backs up what
Postgres 18 holds into `~/booster-rocket-moving-to-postgres-18/postgres-18-before-again` and prints the file's name.
If Postgres 18 holds work done after the move, it stops there (exit code 2), changes nothing else, and shows when the
move was made and the newest record in each copy:
- to keep the Postgres 16 data (what was done since going back), run it again with `--again --discard-18` at the end,
  then step 5; the work done on Postgres 18 is then only in that backup;
- to keep the Postgres 18 data instead, do the same, then before step 5 load that backup over what was moved:
  ```bash
  docker compose -f docker-compose.poc.yml --env-file .env.poc up -d db
  BR_DB_CONTAINER=booster-rocket-db-1 scripts/restore.sh ~/booster-rocket-moving-to-postgres-18/postgres-18-before-again/<booster-rocket file> booster --replace
  ```

## 9. The test checklist

Run these in order, in a private browser window, as they are listed: checks 4 to 7 need a parent who can sign in, so they
come after the checks that connect QuickBooks and read the roster, and keep their numbers. Record each outcome in section 11.

- [ ] 1. Visit https://portaltest.rhinoautomator.com: the portal's sign-in page shows directly. (Only if Cloudflare Access is set up, section 7 B, it first asks for an email code.)
- [ ] 2. Finish setup at `/setup` (Step 3 signs you in as Admin) -> staff home, as Admin.
- [ ] 3. Set the club name and color -> they show on every page.
- [ ] 8. `deploy.sh` run a second time with no changes completes and keeps the app healthy; `--rollback` returns to the previous image and the app stays healthy.
  After a no-change redeploy, `previous` and `current` are the same image, so `--rollback` only exercises the mechanism; a real rollback test needs a real new commit.
- [ ] 9. Confirm the app can't send as any other mailbox, two ways.
  - Configuration check. In PowerShell 7 run `Connect-ExchangeOnline -ShowBanner:$false` and sign in as an Exchange administrator. Then run `Test-ServicePrincipalAuthorization -Identity <staff app Object ID> -Resource <mailbox>`. The Object ID is the one under **Enterprise applications** > `Booster Rocket (staff)` in Entra, not the one on the app registration (they are different). With `webmaster@fznband.org` as the mailbox, Application Mail.Send shows `InScope` `True`; with any other mailbox, `False`.
  - Real send. Choose **Mail** in the staff menu (Admins only), change **Send as this mailbox** to a different existing mailbox in the tenant, select **Save**, then **Send test email** to an address you can read. It must fail, and the error shown includes `ErrorAccessDenied`. (If it succeeds, the app can send as that mailbox: stop and fix the Exchange Online assignments before going on.) Then change **Send as this mailbox** back to `webmaster@fznband.org`, **Save**, and **Send test email** again; it must succeed. You must do this last part: changing the settings makes mail count as not working, so parent sign-in says "Parent sign-in isn't available yet.", until a test email succeeds. Microsoft caches app permissions for 30 minutes to 2 hours, so a permission change made just before this test may not show yet.
- [ ] 10. Connect the sandbox company (section 5) -> the QuickBooks page says Connected to the company's name.
- [ ] 11. Choose the layered shape -> **Roster** lists the sandbox's families with their students and parents; a School or Vendor customer is not listed.
- [ ] 12. Open a family -> its parents' email and phone show, and the audit log has `roster.family.read` for it.
- [ ] 4. Do this after check 12, once the roster has been read and a test parent added on a sandbox family's page (section 6). Parent: first switch parent sign-ins on (**Parent sign-ins** in the staff menu, **Configure**, step 1, **Switch parent sign-ins on**; it needs only the working mail of check 2, and until then every sign-in is refused: the audit shows `signin.password_refused` with reason `signins_off`). Then at **Set up or reset my password** on `/sign-in` (`/sign-in/password`), enter the test parent's email, open the link mailed from `webmaster@fznband.org` and choose a password -> parent home (with two families, the family chooser first). Sign out, and in a private window sign in at `/sign-in` with the email and that password, get the code from `webmaster@fznband.org`, enter it -> parent home again.
- [ ] 5. After check 4. Audit log shows: `admin.bootstrap`, `staff.bind`, staff `signin`, `signin.code_sent`, parent `signin`, `guardian.activate`, `settings.club.save`, `settings.parents.save` (sign-ins switched on in check 4), `parent.create` and `parent.access.granted` (the test parent added in section 6), and from setup `settings.mail.save`, `settings.mail.test`, `setup.code.issue`, `setup.unlock`, `setup.provider.save`, `setup.admin_email.save`, `setup.finish`, and from the Microsoft certificate steps `certificate.create` and `certificate.activate` (`certificate.retire` appears later, when **Check and switch** after **Replace certificate** retires the old one, and `certificate.discard` after **Discard replacement**). Also `setup.unlock.refused` after entering a wrong code, `setup.provider.remove` after removing a sign-in provider, and `setup.reopen` after running `scripts/poc/reopen-setup.sh`.
- [ ] 6. After check 4. Sign out at both doors -> both `signout` entries appear.
- [ ] 7. After check 4, with sign-ins on (before then every sign-in is refused as `signins_off`). Parent two's address with any password -> "That email and password didn't work…", no email arrives, and the audit shows `signin.password_refused` with reason `unknown_email`.
- [ ] 13. The next day -> the QuickBooks page shows the worker checked in within the last few minutes and **Last renewed** is less than a day old; `docker logs booster-rocket-worker` shows `ran quickbooks.token_refresh: ok` and `ran roster.refresh: ok`.
- [ ] 14. **Disconnect**, then set up again -> the roster says it is no longer current while disconnected, and is current again after reconnecting. The audit log has `quickbooks.disconnect` and a second `quickbooks.connect`.
- [ ] 15. With check 25 (see "Switching companies" in section 5), after a backup: **Disconnect**, then **Connect a different company**, check the box, **Switch companies: sign in to Intuit**, and choose a second sandbox company -> the portal lands on step 3, the QuickBooks page shows the shape as "Not chosen yet." until it is chosen again, and step 3 says how many families have no link yet. The audit log has `quickbooks.switch.asked`, `quickbooks.connect` (with `switchedFrom`), `roster.cleared` and `accounting.links.cleared`. Every family is still on **Families**, unlinked, until it is linked again on **Accounting links**.
- [ ] 16. Customer query order: in the sandbox's API explorer, or with a query in the style of the plan's check script (`q("...")`), run `select * from Customer where Active in (true, false) orderby Id startposition 1 maxresults 1000` and confirm it is accepted (HTTP 200, customers in `Id` order). The portal sends this query for every page of a roster read, so a club with more than 1000 customers loses none between pages.
- [ ] 17. Inactive customer types: make one customer type inactive in the sandbox, run `select * from CustomerType`, and note whether the inactive type still appears in the list (record it in section 11).
- [ ] 18. Parent sign-ins, **Configure**, **Step 1: Parent sign-ins** (section 5, "Parent sign-ins"): **Switch parent sign-ins off** first (they went on in check 4), so this check and the next walk the step from off -> it counts the guardians the portal holds (the test parents added in section 6 among them), whatever the sandbox's Parent customers are, and asks for nothing but working mail.
- [ ] 19. **Switch parent sign-ins on** -> the step says "Parent sign-ins are on."; a test parent signs in at `/sign-in` with their email and password (and, on a browser the portal doesn't know, the emailed code); the audit log has `settings.parents.save`, and no `parent.access.granted` or `parent.access.ended` since check 18 (switching sign-ins gives and ends no membership).
- [ ] 20. In the sandbox, put a test parent's address on a Parent customer under a second family, then **Refresh now** -> nothing changes for anyone: no "address to review", no staff email, and the test parent signs in to their own family as before.
- [ ] 21. **Parents** in the staff menu -> it lists every person with their families and has no **To review**; a test parent added to two families (section 6) is offered both by name in the family chooser.
- [ ] 22. Make a Parent customer inactive in the sandbox, then **Refresh now** -> nobody is signed out for it, and the audit log has no `parent.access.ended`. (A family the portal's records hold as inactive is kept out at the gate: its guardians can't enter it, and their rows stay open.)
- [ ] 23. Open the person from **Parents**: **Block** with a reason in **Why? (staff only)** -> the box says Blocked with the reason, and their password is refused at `/sign-in` with the usual message and no email; **Unblock** -> they can sign in again. The audit log has `parent.read`, `parent.block` and `parent.unblock`.
- [ ] 24. Step 2, **Switch welcome emails on** -> one welcome email arrives within two minutes, with a link to choose a password for a guardian who has none, and `docker logs booster-rocket-worker` shows `ran parents.welcome: ok`; the audit log has `parent.welcome.sent` with `link: "setup"` and `parent.password.link_made`, and no row holds the link. Then, for the testers welcomed before the sign-in release, **Parent sign-ins**, **Email a set-up link to everyone who can sign in and hasn't chosen a password** -> each gets "Choose your password for <club>" with a link, and the audit log has `parent.setup_mail.owed` with the count and a `parent.welcome.sent` with `mail: "choose_password"` and `link: "setup"` for each.
- [ ] 25. After check 15, on the second sandbox company: no `parent.access.cleared` in the audit log; **Parent sign-ins** shows sign-ins and welcome emails as they were; a test parent still signs in, without a new code if their session is live, sees their students and forms, downloads a signed form, and reads that the club hasn't connected their payments yet; **Reconciliation** lists each unpaid buy-out under "From the earlier QuickBooks company", and a paid one still counts on the family's season page. Then, without a switch asked: **Disconnect** and **Connect to QuickBooks** with the first company -> step 2 says "That is a different QuickBooks company from the one the portal's families were read from, so nothing was connected and nothing was changed." Then switch back to the first sandbox company as a second switch, choose the shape, and link every family again on **Accounting links** -> Roster lists its families, and the test parent sees their balance again.

**Reading the audit log:** sign in as staff at `/staff/sign-in` (setup signs you in the first time) and choose **Audit** in the top menu (it
shows only to people who hold the audit-read permission; Admin does). Each row shows time, door
(staff, parent or system), who, the action, and details. A refusal's reason is in the details as
`reason`: each row has a **Details** line you can open, showing the saved before/after values
(for example `{"reason":"unknown_email"}`). Times show in your own device's time zone; the database stores them in UTC (hover a time to see the exact UTC instant; `psql` output follows the server's zone, Central). The person always sees the same
message; the reason is only in the log. If the page itself is unavailable, read the log from the
database on linuxdev:
```bash
cd ~/booster-rocket
docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "select at, door, actor_label, action, before, after from audit_log order by at desc limit 20;"
```

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `signin.refused`, reason `no_enabled_guardian` (after the code was accepted) | The person has no guardian row that counts: every row is closed, or names no family record, or a family that is inactive (or has no active student while "Families with no active student" is on) | Add the test parent again on a family's page (section 6), or **Reinstate** them there. The reason a closed row can't sign in is shown on the person's page under **Parents**, and in the family's **Portal sign-ins** box. Don't re-enable a link with SQL: it bypasses the audit log |
| A parent's sign-in says "That email and password didn't work…"; audit `signin.password_refused`, reason `unknown_email` | No person has that email | Add them on a family's page (section 6): an address in QuickBooks gives nobody a sign-in. Addresses are matched trimmed and lowercased |
| `signin.password_refused`, reason `no_password` | The person hasn't chosen a password yet | They choose **Set up or reset my password** on `/sign-in` and use the link mailed to them, which signs them in |
| `signin.password_wrong` | The password typed isn't theirs | They try again, or set a new one from **Set up or reset my password** |
| `signin.password_refused` or `signin.code_refused`, reason `no_enabled_guardian` | The person has no guardian row that counts | As in the first row |
| `signin.password_refused`, reason `rate_limited` | Details `limit` says which limit: `email`, 5 wrong tries for one address (a right password isn't counted); `device`, 5 wrong tries on a browser the portal remembers for the person, counted in place of the address; `ip`, 180 tries from one IP; `busy`, more tries arriving at once than the portal checks (written at most once in 15 minutes). The parent sees "Too many tries. Wait a few minutes and try again." For `email`, `device` and `ip`, a full window is recorded once | Wait up to 15 minutes, until the oldest try in the window is 15 minutes old; a reset doesn't shorten it. `busy`: try again in a moment |
| `signin.refused`, reason `no_pending_step` (the parent sees "That code didn't work.") | A code was entered with no password step behind it on that browser: the step's 10 minutes ran out, or the code was typed in another browser | Enter the email and password again, on the browser that will enter the code |
| `signin.code_refused`, reason `rate_limited` | Details `limit` says which limit: `resend`, a new code asked for within 60 seconds of the last one; `email`, 3 codes to one address; `ip`, 60 codes sent to one IP (a code is sent only after a right password); `check_ip`, 180 code checks from one IP (the parent sees "Too many tries. Wait a few minutes and try again."). The last three count 15 minutes back. For `email`, `ip` and `check_ip`, a full window is recorded once: the first refused request writes the row, and later ones in the same window write nothing | `resend`: wait 60 seconds. The others: wait up to 15 minutes, until the oldest request in the window is 15 minutes old |
| The sign-in page says "We couldn't reach the portal just then. Please try again in a moment." and there's no audit row | More than 20 code requests, or 20 code checks, from one IP in a minute: the portal turns them away before they are counted or recorded | Wait a minute |
| `signin.code_refused`, reason `mail_failed`, with `detail: "mail_not_working"`, and no `mail.failed` row | Mail isn't set up, or its settings haven't had a successful test email since they were saved, so nothing was sent | **Mail** in the staff menu (Admins only): **Send test email** |
| `signin.code_refused`, reason `mail_failed` with no `detail`, and a `mail.failed` row | Microsoft 365 or SMTP refused the message; the `mail.failed` row has the provider's error | For `ErrorAccessDenied`, rerun section 4 step 3 and wait up to 2 hours; staff see the same error on the staff home page |
| `/sign-in` says "Parent sign-in isn't available yet." | Mail settings aren't saved, or haven't had a successful test since they changed | **Mail** in the staff menu (Admins only): **Send test email** |
| Parent `signin.refused`, reason `family_not_enabled` | The parent was in, or chose, a family that isn't one of their enabled families. Usually the family's row was disabled while they were signed in: they are sent back to choose a family, and Details names the one they lost. With no family in Details, the chooser was sent something that isn't a family ID | Nothing, if the link was closed on purpose. Otherwise see the first row: the person's page under **Parents** says why the link is closed |
| Parent `signin.refused`, reason `address_changed` (the parent sees "That code didn't work.") | The person's email address was changed (by a roster refresh, by staff or by the parent) at the moment they entered a code that was sent to the old address | Nothing: they sign in with the new address |
| "Too many tries. Wait a few minutes and try again." | 180 code checks or 180 password tries from one IP in 15 minutes, or 5 wrong passwords for one address or on one remembered browser (the audit row above says which) | Wait 15 minutes |
| Staff `signin.refused` (door staff; staff refusals carry no reason, so Details is empty) | The Microsoft account is not a known staff member and is not the first Admin email entered in Step 3 of setup | Sign in with that email, or have an Admin add the person first (**Staff** menu) |
| Microsoft error "AADSTS50011: The redirect URI ... does not match" | Redirect URI in the app registration differs from the one the portal sends | `https://portaltest.rhinoautomator.com/api/auth/staff/callback/microsoft`. Platform must be **Web**; no trailing slash |
| The setup page refuses the Microsoft tenant ID | It is `common`, `organizations`, `consumers` or something that is not a GUID | Use the **Directory (tenant) ID** GUID from the band's tenant Overview page; also set the registration to **Single tenant only** |
| The staff app registration was created as multi-tenant | Wrong **Supported account types** choice | Entra > the app > **Authentication** > **Supported account types** > **Single tenant only** |
| Setup code does not work | It is wrong, was replaced by a newer one, was slowed down by too many wrong tries, or is void | Run `scripts/poc/setup-code.sh` for a fresh code and use that one |
| Microsoft doesn't have this certificate on the app yet (`AADSTS700027`) | The `.cer` was not uploaded to the app registration, or Microsoft has not picked it up yet | Upload the `.cer` under **Certificates & secrets** > **Certificates** (or run the script), wait a minute, and try again |
| The server's clock looks wrong, so Microsoft refused the certificate (`AADSTS700024`) | The time on linuxdev is off | Fix the time on linuxdev, then try again |
| The tenant blocks client secrets (`CredentialTypeNotAllowedAsPerAppPolicy`) | The tenant's "Block password addition" app policy, which stops apps from getting client secrets, refused the request | Nothing needs changing: this is why Microsoft sign-in uses certificates. Use the certificate steps in section 3 (Google still uses a secret) |
| Nobody can sign in (for example, a certificate or Google client secret expired) | Sign-in values need replacing | Run `scripts/poc/reopen-setup.sh`, enter the code at `/setup`, and re-enter the values (for Microsoft, select **Replace certificate**, upload the new `.cer` in Entra, then **Check and switch**). Existing Admins stay Admins |
| Sign-in shows "not set up" after `.env.poc` was changed or replaced | `SETTINGS_ENCRYPTION_KEY` changed, so the stored secrets cannot be read | Put the old key back if you have a backup; otherwise run `scripts/poc/reopen-setup.sh` and re-enter the secrets (for Microsoft, select **Replace certificate** on the setup page, upload the new `.cer` in Entra, then **Check and switch**) |
| Step 3 says it is a different account | You are signed in to Microsoft as someone other than the Admin email you entered | Sign out of Microsoft, then sign in as the Admin email |
| Browser shows Cloudflare 502 | `cloudflared` cannot reach `booster-rocket-app:3000`: the edge network was not added to cloudflared, cloudflared was not recreated, or the app is unhealthy | `docker network inspect booster-rocket-edge` must list both `cloudflared` and `booster-rocket-app`; if not, redo section 2 steps 3-4. Then `docker ps` for `(healthy)` and `docker logs booster-rocket-app` |
| Form buttons or sign-in fail with a server action or origin/forbidden error | HTTP Host Header is set in the tunnel route, or `APP_URL` is wrong | Clear the HTTP Host Header (section 7 A5); make `APP_URL=https://portaltest.rhinoautomator.com` exactly, then recreate the app |
| Deploy or migrate fails with a database password error after re-running setup | `.env.poc` was deleted and regenerated (new `DB_PASSWORD`) | See the note at the end of section 2 |
| Step 2 of the QuickBooks steps comes back with "That return from Intuit didn't match a sign-in started here, or it was more than 10 minutes old. Start again." | More than 10 minutes passed, or the button was pressed in two tabs | Start step 2 again |
| Step 2 comes back with "Intuit refused the request. Check the Client ID, the Client secret and the choice of sandbox or production in step 1, and that the redirect address is on the Intuit app." | The Client ID, secret or sandbox/production choice is wrong, or the redirect address isn't on the Intuit app under the same keys | Fix step 1, and check the redirect address on the Intuit app (section 5 step 1) |
| Step 2 comes back with "That is a different QuickBooks company from the one already connected. Disconnect first if you mean to switch companies." | A company is already connected | **Disconnect** on the QuickBooks page first, then set up again |
| Step 2 comes back with "That is a different QuickBooks company from the one the portal's families were read from, so nothing was connected and nothing was changed." | The company chosen in Intuit isn't the one the roster was read from, and no switch was asked for first (or the ask ran out after 10 minutes) | Set up again and choose the first company in Intuit, or select **Connect a different company** first to switch |
| The roster refresh fails with "The roster was read from another QuickBooks company than the one connected now, and nobody chose to switch to it, so it wasn't read. ... (roster_company)" | A connection to another company was stored with no switch asked for: before the portal refused one, or by hand | **Disconnect**, then connect the first company again, or switch |
| The staff home says "QuickBooks needs attention" with "The roster hasn't been refreshed from QuickBooks in more than 2 days." | The worker isn't running | `docker ps`, then `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d worker` |
| The staff home says "The QuickBooks connection couldn't be refreshed: Intuit no longer accepts this connection. Connect QuickBooks again." | The connection lapsed or was revoked at Intuit | Go through step 2 of the QuickBooks steps again |
| The staff home says "The last roster refresh failed: The portal's own family and student records couldn't be brought up to date, so the roster was left as it was. (app_records_failed)" (or, older still, "The parent sign-ins couldn't be brought up to date ... (reconcile_failed)") | A version from before stage 3's slice 9c, whose refresh still kept the portal's family records in step, failed in that step | Neither can happen from slice 9c on: a refresh stores the customer list and changes no record or sign-in. Deploy the update; on an older version, read `docker logs booster-rocket-app` for a line like `[roster] app records failed { name: 'DrizzleQueryError', code: '23505', constraint: '...' }` (the error's class name, the database's SQLSTATE code and the constraint; never the message or an address) and report it |
| `/sign-in` says "Parent sign-in isn't available yet." after parent sign-ins were switched off | Sign-ins are off, so nobody can sign in (the audit shows `signin.password_refused`, reason `signins_off`) | **Parent sign-ins** in the staff menu, **Configure**, step 1: **Switch parent sign-ins on**. Welcome emails went off with them; switch them on again in step 2 if wanted |
| `docker logs booster-rocket-worker` says "couldn't reach the app: HTTP 404" | The worker and the app have different `BETTER_AUTH_SECRET` values | Both read `.env.poc`: recreate both |
| Only if Access is set up: Cloudflare never emails a code | The email is not in the Allow policy, or One-time PIN is not enabled on the application | Section 7 B steps 1-3; check spam |

## 11. Results

Fill one row per checklist step each time you run it.

| Date | Commit | Step | Pass/Fail | Notes |
|---|---|---|---|---|
| 2026-11-09 | 994f231 | 1 | Pass | Cloudflare Access skipped by choice; the setup page showed directly. |
| 2026-11-09 | 994f231 | 2 | Pass | Staff Microsoft sign-in with a certificate (the band tenant blocks client secrets: `CredentialTypeNotAllowedAsPerAppPolicy`). The staff script created the app, granted consent and added the certificate; a re-run reused the app and found the certificate already there. Signed in as webmaster@fznband.org and was made Admin. |
| 2026-11-09 | 994f231 | 3 | Pass | Name "FZN Band Boosters", color #005102. Short name still the default "BR"; set it under Club. |
| 2026-11-09 | 994f231 | 4 | Not run | Waiting on outgoing mail (section 4). |
| 2026-11-09 | 994f231 | 5 | Partial | Present: `setup.code.issue`, `setup.unlock`, `certificate.create` (staff, plus a pending parent certificate made by downloading the parent script), `certificate.activate`, `setup.provider.save`, `setup.admin_email.save`, staff `signin`, `admin.bootstrap`, `setup.finish`, `settings.club.save`, `signout`. No `staff.bind`: the first Admin is created already bound, so it only appears for invited staff. Parent rows wait on step 4. |
| 2026-11-09 | 994f231 | 6 | Partial | Staff sign-out recorded. Parent sign-out waits on step 4. |
| 2026-11-09 | 994f231 | 7 | Not run | Waiting on outgoing mail (section 4). |
| 2026-11-09 | 994f231 | 8 | Pass | Redeploy kept `previous` and stayed healthy; `--rollback` returned to it and stayed healthy (both images were the same commit, so this tested the mechanism). |
| 2026-11-10 | 03b74bf | 4 | Pass | Upgraded the finished site (section 4, "Upgrading"): backup taken, deployed, mail set up from **Mail**. A seeded parent with one family asked for a code, got it from `webmaster@fznband.org`, entered it and reached the parent home. The two-family chooser was not tried. |
| 2026-11-10 | 03b74bf | 5 | Pass | For the parent and mail rows: `settings.mail.save`, `settings.mail.test`, `signin.code_sent`, `guardian.activate`, parent `signin` (family `POC-FAMILY-1`). No sign-in row holds a code. |
| 2026-11-10 | 03b74bf | 6 | Pass | Parent `signout` recorded. |
| 2026-11-10 | 03b74bf | 7 | Pass | An address with no person got the same message and no email; the audit shows `signin.code_refused`, reason `unknown_email`. |
| 2026-11-10 | 03b74bf | 9 | Pass (one part not run) | Real send: with **Send as this mailbox** set to another mailbox in the tenant, the test email failed with `ErrorAccessDenied`; set back to `webmaster@fznband.org`, it succeeded. Configuration check: `InScope` was `True` for `webmaster@fznband.org`; the check against another mailbox (expect `False`) was not run. |
| 2026-11-11 | f0f6bb0 | 10 | Pass | Connected to "Sandbox Company US 9954" with the Development keys. The audit log has `settings.quickbooks.save` and `quickbooks.connect` with the company name. |
| 2026-11-11 | f0f6bb0 | 11 | Pass | Layered shape (Family, Student, Parent). The roster read 34 customers and 5 types and shows 1 family, 1 student, 1 parent, with 31 customers outside the portal; no School or Vendor customer is listed. Contact details are kept for 3 of the 34 customers, the ones the shape names. |
| 2026-11-11 | f0f6bb0 | 12 | Pass | The family page shows the parent's email and phone, and the audit log has `roster.family.read` for it. **Refresh now** worked, and a second press inside 5 minutes was refused with the right message. |
| 2026-11-11 | f0f6bb0 | 13 | Not run | Needs a day. The worker did renew the connection during the walkthrough (`ran quickbooks.token_refresh: ok`). |
| 2026-11-12 | 82e4639 | 13 | Pass | With nobody visiting, the worker renewed the connection at 14:04 Central (24 hours after the last renewal) and re-read the roster at 18:41 (24 hours after the last read): `ran quickbooks.token_refresh: ok` and `ran roster.refresh: ok` in its log, both recorded as started by the worker. The read found 34 customers and 4 customer types (`School` was made inactive for check 17, so QuickBooks leaves it out). The worker was restarted by a deploy that morning and still ran both on time. |
| 2026-11-11 | f0f6bb0 | 14 | Pass | `quickbooks.disconnect` with `revoked: true`; the roster pages said the roster was no longer current and hid **Refresh now**; after reconnecting to the same company the notice was gone and nothing was cleared. |
| 2026-11-11 | f0f6bb0 | 15 | Pass | Both directions. Connecting "Sandbox Company US a680" wrote `roster.cleared` (reason `different_company`), removed the shape and read 29 customers and no types; **Roster** and the QuickBooks page said what the checklist expects. Switching back to "9954" cleared it again, and the shape was chosen again. |
| 2026-11-11 | fdebe0b | 16 | Pass | `select * from Customer where Active in (true, false) orderby Id startposition 1 maxresults 1000` was accepted (HTTP 200) and returned all 34 customers in `Id` order, compared as numbers (1 to 100000041). |
| 2026-11-11 | fdebe0b | 17 | Pass | With `School` made inactive, `select * from CustomerType` returned 4 types, all `Active=true`: QuickBooks leaves an inactive type out of the list. So a shape that names a type later made inactive is reported as naming a type QuickBooks no longer has, after the next refresh. |

Findings from the 2026-11-09 run, all fixed on `main`:

- **The band tenant blocks client secrets,** so Microsoft sign-in now uses app-generated certificates (no secret anywhere).
- **Deploys on Docker 29:** the first redeploy failed while tagging the rollback copy, because the old image's record was gone once `current` moved to the new build. Fixed in `e58b69a`: the copy is now kept before the build, and a tagging failure can't stop a deploy. Because `deploy.sh` updates itself during its own `git pull`, the first deploy after a script change still runs the old copy.
- **The scripts created a new app on every run,** because Microsoft's filter-by-name lookup returned nothing. Fixed in `994f231`: the scripts now list the apps and match the name themselves. Delete any duplicate apps by hand.
- **Windows blocks downloaded scripts:** run `Unblock-File` first. Browsers also save a second download as `name (1).ps1`, so delete the old file before downloading again.

2026-11-10: an account an admin creates in External ID always has a password, so External ID can't give parents email-code-only sign-in with sign-up off. Parents now get codes from the portal itself (spec 2026-11-10).

Findings from the 2026-11-10 run:

- **The script's mail part ended without a word on its first run,** right after printing the mailbox's details and
  before it created anything in Exchange Online. The mailbox lookup was piped into `Select-Object -First 1`. Fixed
  in `0acf4fc`; the second run finished with "The app can now send as webmaster@fznband.org, and only as
  webmaster@fznband.org". A finished run always ends with the Tenant ID block; if that block is missing, the script
  did not finish.
- **Microsoft took about an hour to apply the permission.** Test emails failed with `ErrorAccessDenied` from 16:03
  to 16:22 (Central) and the next one, at 17:20, succeeded. Every failed test is a call from the app, and Microsoft
  keeps an active app's cached permissions for up to 2 hours, so retrying every few minutes can lengthen the wait.
  Wait 30 minutes after the last attempt before trying again. `Test-ServicePrincipalAuthorization` shows the real
  state at once, because it skips that cache.
- **The Mail page's instructions didn't look like instructions:** the script steps were inside a collapsed section
  under the form. They are numbered steps above the form now (`03b74bf`); `docs/ui-backlog.md` has what is left.
- **The upgrade worked as written:** the one old guardian row became a person with a new sign-in account, and
  `/sign-in` said "Parent sign-in isn't available yet." until the first successful test email. The backup was
  taken but the restore steps were not tried.

Findings from the 2026-11-11 run (QuickBooks):

- **The redirect address isn't on Intuit's Keys and credentials page.** It is under the app's **Settings** >
  **Redirect URIs**. Section 5 and step 1 in the portal said the wrong page; both now name the right one.
- **A refused Refresh now on a family's page wrote a second `roster.family.read` row,** because the page was
  rendered again although nothing had changed. A refusal no longer renders the page again.
- **Disconnecting showed no confirmation,** because the button that would say so left the page with the connection.
  The QuickBooks page now says "Disconnected." and its Roster box says the roster is no longer current.
- **The disconnected notice on a family's page ran wider than the column.** It keeps to the column now.
- **A second sandbox company has no customer types,** so step 3 has nothing to choose from there. That is the
  sandbox's data, not a fault, but it means a company-switch test can only check the clearing.

2026-11-12: parent sign-ins from QuickBooks (section 5) were deployed at `82e4639`. The database was backed up first
to `~/booster-rocket-before-parents.sql` on linuxdev. Migration 0009 ran, the app came up healthy and the worker
kept waking. Parent sign-ins are still switched off: the two sign-ins seeded by hand on `POC-FAMILY-1` work as
before. Checks 18 to 25 have not been run; add a row per check above when they are.

2026-11-17: the whole of v1 was deployed at `06fbcf5`. The database was backed up by hand first, then again by the
deploy script, into `~/booster-rocket-backups`. Migrations 0010 to 0022 ran, the app came up healthy, the worker ran
its first jobs, and the portal's address answered for the health check, both sign-in pages and the app manifest.

2026-11-17: the database was moved to Postgres 18 (section 8) at `d1a896b`. It was backed up with Postgres 16 first.
The move ended with `booster: 54 tables, every one with the same number of rows as before.`, and the deploy after it
with `Deployed d1a896b.` on PostgreSQL 18.7, the app healthy and the address answering. The same day the newest
Postgres 18 backup was restored into `booster_restore_check` with `scripts/restore.sh` (54 tables; the audit log's 96
rows the same as the live database's) and that scratch database was dropped. Then, on the owner's word, Postgres 16's
data was removed: the portal was stopped, the database's container removed, `docker volume rm booster-rocket-pgdata`,
`docker compose ... up -d` (not `down`: the tunnel's container is on this project's network), and
`~/booster-rocket-moving-to-postgres-18` deleted. Going back to Postgres 16 is no longer possible on this host. An
empty volume named `booster-rocket-pgdata` remains, because the compose file names it for the start check.

2026-11-28: the backup service was tried before it was merged, on the owner's word, from this change's
`docker-compose.poc.yml` and `scripts/` copied to `~/booster-rocket-backup-trial` (the checkout left clean), after a
`pg_dump` to `~/booster-rocket-before-backup-agent-20261128T060725Z.sql`. Its heartbeat and the folder's list reached
the portal; a backup asked for through `backup_request` was made, owned by the deploying user; a download was staged
in the outbox, readable by the app's user, its dump the same bytes as the backup. A restore was tried only on a
throwaway project, `booster-rocket-scratch` (its own Postgres, network and folder), loaded from that backup: the
agent made a fresh backup, ended a held connection, swapped the database, wrote `backup.restore.done`, and putting
the fresh backup back undid it. Linuxdev runs no Documenso, so whether Documenso copes with its database restored
underneath it was not tried.

Get the commit with `git -C ~/booster-rocket rev-parse --short HEAD` (the deploy script prints it too).

Record results from the development checkout (on Windows), not by committing on linuxdev: a local commit there makes the next `git pull --ff-only` fail (exit 6) or trips the clean-tree check (exit 2).

## 12. Removing the proof of concept

Do these in order. Removing the network first would break cloudflared's next start (including the weekly
update) and take the tunnel down for n8n and CIPP.

1. Stop and remove the app (the same command removes the worker):
   ```bash
   cd ~/booster-rocket
   docker compose -f docker-compose.poc.yml --env-file .env.poc down
   ```
2. Revert the edit to `~/n8n/docker-compose.yml` (remove `booster-rocket-edge` from cloudflared's `networks:`
   and from the top-level `networks:`), then recreate cloudflared:
   ```bash
   docker compose -f ~/n8n/docker-compose.yml up -d --no-deps cloudflared
   docker logs cloudflared 2>&1 | grep "Registered tunnel connection"
   ```
3. Only now remove the network: `docker network rm booster-rocket-edge`
4. Optional: delete the data with `docker volume rm booster-rocket-postgres booster-rocket-pgdata` (Postgres 18's and,
   if still there, Postgres 16's from before the move), and the images with
   `docker image rm booster-rocket-app:current booster-rocket-app:previous`.
