# Booster Rocket proof of concept on linuxdev: runbook

Follow this top to bottom, with one exception: the `/setup` page only exists after the first deploy (section 8).
Sign-in and outgoing mail are set up on the setup page after the first deploy (sections 3 and 4); a site that already finished setup uses "Upgrading a site that already finished setup" in section 4 instead. Each section is numbered steps. Anything in `monospace` is typed or
pasted exactly. Dashboard click paths were checked against Microsoft Learn and Cloudflare's
documentation on 2026-11-08; the sources are listed under each section. The outgoing-mail steps (section 4)
were added after that and were first walked through on 2026-11-10, on a site that had already finished setup
(section 11). If a screen no longer matches,
trust the screen and note it in the Results table.

**Since 2026-11-16 the staff menu is grouped, and every setting is under Settings.** Where this runbook says **Mail**,
**Sign-in**, **QuickBooks** or **Parent sign-ins** "in the staff menu", open **Settings** in the staff menu, then that
part's box (**Outgoing mail**, **Staff sign-in**, **QuickBooks**, **Parent sign-ins**) and its **Set up** or **Change**.
**Audit** is under **Admin**. The setup page now asks for the club first, so its steps are one later than written below:
outgoing mail is Step 3 and the first Admin Step 4. The checks still to make before families use the portal, this
host's among them, are in [before the first family](before-the-first-family.md).

## 1. What this is

This puts Booster Rocket on the Linux host `linuxdev` at https://portaltest.rhinoautomator.com, behind
a Cloudflare tunnel (and, optionally, Cloudflare Access), so you can prove that staff sign-in (the band's Entra
tenant or Google), parent sign-in (a 6-digit code the portal emails from
`webmaster@fznband.org`) and the audit log work for real. It also proves that the portal can connect to a
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

   This goes in the n8n file, not a Booster Rocket file, because the weekly cron script that updates
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
  docker volume rm booster-rocket-pgdata
  ```
  Deploy again; the deploy prints a new setup code, and you go through the setup page (sections 3
  and 4) again. After the deploy, re-run the seed in section 6 (the guardian rows are gone).

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

Parents sign in with a code the portal emails them, so mail must work before any parent can sign in. The portal
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
3. Sign in at `/staff/sign-in` and choose **QuickBooks** in the staff menu (Admins only), then **Set up**.
4. Step 1: enter the Development **Client ID** and **Client secret**, choose **Sandbox**, **Save**.
5. Step 2: **Sign in to Intuit**, choose the sandbox company, **Connect**. You come back to step 3.
6. Step 3: choose **Layered**, `Family` for the family, `Student` for the student, `Parent` for the parent,
   **Preview**, check the counts and names, then **Save this shape**.
7. Choose **Roster** in the staff menu: the families are listed, and **Needs attention** shows what to tidy up.
8. The worker: `docker ps --filter name=booster-rocket-worker` shows it running, and
   `docker logs booster-rocket-worker` shows `worker started` and a line each time it runs a job. The QuickBooks page
   shows when it last checked in. On the first deploy that includes the worker, `docker ps --filter name=booster-rocket-worker`
   may show nothing: `deploy.sh` updates itself during its own `git pull`, so that run is still the old copy, which
   recreates only the app. Run `scripts/poc/deploy.sh` once more (or
   `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d worker`); every deploy after that starts it.

**Switching companies.** Disconnecting and then connecting a different QuickBooks company (for example, moving from the
sandbox to the band's real books) clears the roster and the membership shape, which must be chosen again in step 3.
It also closes every parent sign-in link and signs parents out, switches parent sign-ins and welcome emails off,
and keeps a list of the old company's families, and who could sign in to them, for the match review under
**Parent sign-ins**. That list is deleted 90 days after the switch, or sooner by an Admin. Everything else the portal
holds about the old company's customers goes too (money figures, seasons' ticks, volunteering, forms being signed,
changes waiting), and signed forms' evidence is kept: [reconnecting QuickBooks](quickbooks-reconnect.md#connecting-a-different-company)
has the whole list.

The worker is verified to keep running with no input attached and to stop cleanly on `docker stop` (exit code 0,
`worker stopped` in its log). That was checked on linuxdev on 2026-11-11 with the script alone in a `node:26-slim`
container. As the compose service there it ran with no restarts through the 2026-11-11 walkthrough and renewed the
connection (`ran quickbooks.token_refresh: ok`).

Moving to the band's real books later means the app's **Production** keys, **Production** in step 1, and Intuit's app
assessment first.

### Parent sign-ins from QuickBooks

Once an Admin switches it on, a parent who is a Parent customer in QuickBooks can sign in with the address on that
record and a code; nobody seeds them by hand. Do this after the QuickBooks steps above.

1. **Before you deploy, back up the database.** The deploy runs migration 0009, which changes the parent tables.
   On linuxdev:
   ```bash
   cd ~/booster-rocket
   docker compose -f docker-compose.poc.yml --env-file .env.poc exec -T db pg_dump -U booster -d booster > ~/booster-rocket-before-parents-from-quickbooks.sql
   ```
   As before, the file goes in your home folder, not the checkout. The restore steps are in section 4,
   "Upgrading" (step 5), with this file name in place of the one there. Then deploy (section 8).
2. In the sandbox company, give the Parent customer `Test Parent` an email address you can read.
3. Choose **Roster** in the staff menu, then **Refresh now**.
4. Choose **Parent sign-ins** in the staff menu (Admins only), then **Set up**.
5. Read **Step 1: What would happen**. The test sign-ins seeded by hand on `POC-FAMILY-1` (section 6) are listed
   under **Sign-ins that would end**: QuickBooks doesn't list them, so they stop working when sign-ins are switched
   on. The counts should match the sandbox.
6. **Next: parent sign-ins**, then **Switch parent sign-ins on**. The step then says "Parent sign-ins are on." with
   how many people can sign in. No email is sent.
7. In a private window, sign in as that parent at `/sign-in` with the code that arrives.
8. **Next: welcome emails** (step 3), then **Switch welcome emails on**. Within a minute or two the parent gets the
   welcome email.

Switching parent sign-ins **off** (step 2, **Switch parent sign-ins off**) signs every parent out at once, and also
switches welcome emails off. Switching sign-ins on again does not switch welcomes back on: do step 3 again.

**Parents** in the staff menu (needs the Parents permission; Admin has it) lists addresses to review and every
person, with block and unblock on each person's page. Names and addresses are changed in QuickBooks, followed by
**Refresh now**.

A sign-in made by hand that staff removed before this version is opened again if QuickBooks lists that parent under
that family.

## 6. Test parents

1. **Wait until the first deploy in section 8 has succeeded.** Then, on linuxdev, seed parent one:
   ```bash
   cd ~/booster-rocket
   docker compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/seed-poc-guardian.mjs --name "<name>" --email "<email you can read>" --family POC-FAMILY-1
   ```
   Success prints `seeded guardian <id>`. It refuses unless the env file holds `BR_PROOF_OF_CONCEPT=yes` (add that line to `.env.poc` on a proof of concept, never on a club's real portal). Running it again with
   the same email and family prints "That person is already a guardian in that family." The same email with
   `--family POC-FAMILY-2` adds a second family to the same person.
2. Parent two is any other address you can read. It gets no guardian row on purpose (checklist step 7).

The seed script makes a sign-in by hand, for testing before parent sign-ins are switched on. It sends no welcome
email; tell the parent to go to `/sign-in` and ask for a code. Once parent sign-ins are switched on, sign-ins come
from QuickBooks, and a hand-made one that QuickBooks doesn't list stops working (section 5, "Parent sign-ins from
QuickBooks").

**Blocking a parent.** Choose **Parents** in the staff menu, open the person, enter a reason under
**Why? (staff only)** and choose **Block**; **Unblock** on the same page gives back the same access. Both are in the
audit log (`parent.block`, `parent.unblock`), and blocking signs the person out at once.

**Last resort, only if the staff pages are unavailable.** On linuxdev:
```bash
cd ~/booster-rocket
docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "update parent set blocked = true where email = '<address>';"
```
Use the address trimmed and lowercased, as the portal stores it. From then on they get no more codes (the audit
shows `signin.code_refused`, reason `blocked`), a code they already have is refused when they enter it, and the next time they
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
   name:** `Booster Rocket testers`. **Action:** **Allow**. Set a **Session duration**. Under **Rules**, add
   an **Include** rule with the **Emails** selector and enter each tester's email (the owner and the
   test parents). **Save**.
3. Create the application: **Zero Trust** > **Access controls** > **Applications** > **Create new
   application** > **Self-hosted and private**. Select **Add public hostname**, enter subdomain
   `portaltest` and domain `rhinoautomator.com`. Under **Access policies** add the existing
   `Booster Rocket testers` policy. Under identity providers select **One-time PIN** (turn off
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
   migrations, recreates the app and waits up to 120 seconds for it to become healthy, then starts the worker. The first build
   takes several minutes. A worker that won't start doesn't fail the deploy: it prints "The worker didn't start. The
   site is up; check: docker logs booster-rocket-worker".
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
   | 2 | Refused: local changes, `.env.poc` missing, not mode 600 or without an `APP_URL` line, or another deploy is running | Read the message; fix; run again |
   | 3 | Migrations failed; running app untouched | Read the migrate output above the message; check `DB_PASSWORD` (end of section 2) |
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
   `docker compose -f docker-compose.poc.yml --env-file .env.poc logs db`.
6. After the first successful deploy, finish setup at `/setup` (sections 3 and 4), then do section 6
   step 1 (the seed).
7. **Need a code later?** `scripts/poc/setup-code.sh` prints a new one (the old code stops working) while
   setup is open. **Nobody can sign in** (for example, a certificate or Google client secret expired)?
   `scripts/poc/reopen-setup.sh` reopens setup and prints a code. Stored sign-in values are kept and
   existing Admins stay Admins.

## 9. The test checklist

Run these in order, in a private browser window. Record each outcome in section 11.

- [ ] 1. Visit https://portaltest.rhinoautomator.com: the portal's sign-in page shows directly. (Only if Cloudflare Access is set up, section 7 B, it first asks for an email code.)
- [ ] 2. Finish setup at `/setup` (Step 3 signs you in as Admin) -> staff home, as Admin.
- [ ] 3. Set the club name and color -> they show on every page.
- [ ] 4. Parent: at `/sign-in`, enter the seeded parent's email, get the code from `webmaster@fznband.org`, enter it -> parent home (with two families, the family chooser first).
- [ ] 5. Audit log shows: `admin.bootstrap`, `staff.bind`, staff `signin`, `signin.code_sent`, parent `signin`, `guardian.activate`, `settings.club.save`, and from setup `settings.mail.save`, `settings.mail.test`, `setup.code.issue`, `setup.unlock`, `setup.provider.save`, `setup.admin_email.save`, `setup.finish`, and from the Microsoft certificate steps `certificate.create` and `certificate.activate` (`certificate.retire` appears later, when **Check and switch** after **Replace certificate** retires the old one, and `certificate.discard` after **Discard replacement**). Also `setup.unlock.refused` after entering a wrong code, `setup.provider.remove` after removing a sign-in provider, and `setup.reopen` after running `scripts/poc/reopen-setup.sh`.
- [ ] 6. Sign out at both doors -> both `signout` entries appear.
- [ ] 7. Parent two's address -> the same "If this email belongs to a family…" message, no email arrives, and the audit shows `signin.code_refused` with reason `unknown_email`.
- [ ] 8. `deploy.sh` run a second time with no changes completes and keeps the app healthy; `--rollback` returns to the previous image and the app stays healthy.
  After a no-change redeploy, `previous` and `current` are the same image, so `--rollback` only exercises the mechanism; a real rollback test needs a real new commit.
- [ ] 9. Confirm the app can't send as any other mailbox, two ways.
  - Configuration check. In PowerShell 7 run `Connect-ExchangeOnline -ShowBanner:$false` and sign in as an Exchange administrator. Then run `Test-ServicePrincipalAuthorization -Identity <staff app Object ID> -Resource <mailbox>`. The Object ID is the one under **Enterprise applications** > `Booster Rocket (staff)` in Entra, not the one on the app registration (they are different). With `webmaster@fznband.org` as the mailbox, Application Mail.Send shows `InScope` `True`; with any other mailbox, `False`.
  - Real send. Choose **Mail** in the staff menu (Admins only), change **Send as this mailbox** to a different existing mailbox in the tenant, select **Save**, then **Send test email** to an address you can read. It must fail, and the error shown includes `ErrorAccessDenied`. (If it succeeds, the app can send as that mailbox: stop and fix the Exchange Online assignments before going on.) Then change **Send as this mailbox** back to `webmaster@fznband.org`, **Save**, and **Send test email** again; it must succeed. You must do this last part: changing the settings makes mail count as not working, so parent sign-in says "Parent sign-in isn't available yet.", until a test email succeeds. Microsoft caches app permissions for 30 minutes to 2 hours, so a permission change made just before this test may not show yet.
- [ ] 10. Connect the sandbox company (section 5) -> the QuickBooks page says Connected to the company's name.
- [ ] 11. Choose the layered shape -> **Roster** lists the sandbox's families with their students and parents; a School or Vendor customer is not listed.
- [ ] 12. Open a family -> its parents' email and phone show, and the audit log has `roster.family.read` for it.
- [ ] 13. The next day -> the QuickBooks page shows the worker checked in within the last few minutes and **Last renewed** is less than a day old; `docker logs booster-rocket-worker` shows `ran quickbooks.token_refresh: ok` and `ran roster.refresh: ok`.
- [ ] 14. **Disconnect**, then set up again -> the roster says it is no longer current while disconnected, and is current again after reconnecting. The audit log has `quickbooks.disconnect` and a second `quickbooks.connect`.
- [ ] 15. **Disconnect**, then connect a second sandbox company -> the old company's families are gone: **Roster** says "The membership shape hasn't been chosen yet." and the QuickBooks page shows the shape as "Not chosen yet." until it is chosen again in step 3. The audit log has `roster.cleared`.
- [ ] 16. Customer query order: in the sandbox's API explorer, or with a query in the style of the plan's check script (`q("...")`), run `select * from Customer where Active in (true, false) orderby Id startposition 1 maxresults 1000` and confirm it is accepted (HTTP 200, customers in `Id` order). The portal sends this query for every page of a roster read, so a club with more than 1000 customers loses none between pages.
- [ ] 17. Inactive customer types: make one customer type inactive in the sandbox, run `select * from CustomerType`, and note whether the inactive type still appears in the list (record it in section 11).
- [ ] 18. Parent sign-ins, **Set up**, **Step 1: What would happen** (section 5, "Parent sign-ins from QuickBooks") -> the hand-seeded sign-ins on `POC-FAMILY-1` are listed under **Sign-ins that would end**, and the numbers match the sandbox.
- [ ] 19. **Switch parent sign-ins on** -> the step says "Parent sign-ins are on."; the sandbox parent signs in at `/sign-in` with a code; the audit log has `settings.parents.save` and `parent.access.granted`, with `cause` in its details.
- [ ] 20. In the sandbox, put the same address on a Parent customer under a second family, then **Refresh now** -> the staff home says "1 address to review", neither family can be signed in to with that address, and one staff email arrives (within a few minutes: the worker sends it).
- [ ] 21. **Parents** in the staff menu, under **To review**: type a note in **How do you know? (staff only)** and choose **Same person** -> signing in with that address, the family chooser offers both families by name.
- [ ] 22. Make that Parent customer inactive in the sandbox, then **Refresh now** -> the parent is signed out of that family, and the audit log has `parent.access.ended` with reason `inactive`.
- [ ] 23. Open the person from **Parents**: **Block** with a reason in **Why? (staff only)** -> the box says Blocked with the reason, and their next code request gets the usual message and no email; **Unblock** -> they can sign in again. The audit log has `parent.read`, `parent.block` and `parent.unblock`.
- [ ] 24. Step 3, **Switch welcome emails on** -> one welcome email arrives within two minutes, and `docker logs booster-rocket-worker` shows `ran parents.welcome: ok`.
- [ ] 25. **Disconnect**, then connect the second sandbox company -> the audit log has `parent.access.cleared`; **Parent sign-ins** shows sign-ins switched off and welcome emails off, and a box for the previous QuickBooks company. **Review matches** appears there once the new company's roster is read and a membership shape is chosen (the second sandbox company has no customer types, so this part may not be possible there).

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
| `signin.refused`, reason `no_enabled_guardian` (after the code was accepted) | The person's links to their families are all closed | Before parent sign-ins are switched on: seed the test parent again (section 6). After they are switched on, the fix is in QuickBooks: the Parent customer exists, is active, has one email address and sits under an active family. Then **Refresh now** on the Roster. The reason a person can't sign in is shown on their page under **Parents**, and in the family's **Portal sign-ins** box. Don't re-enable a link with SQL once sign-ins are on: the next reconcile closes it again, and the SQL bypasses the audit log |
| A parent never gets a code; audit `signin.code_refused`, reason `unknown_email` | No person has that email | Before parent sign-ins are switched on: seed them (section 6). After they are switched on, the fix is in QuickBooks: the Parent customer exists, is active, has one email address and sits under an active family. Then **Refresh now** on the Roster. The reason a person can't sign in is shown on their page under **Parents**, and in the family's **Portal sign-ins** box. Addresses are matched trimmed and lowercased |
| `signin.code_refused`, reason `no_enabled_guardian` | All of the person's links to their families are closed | As in the first row: before sign-ins are on, the seed script (section 6); after, fix the record in QuickBooks and **Refresh now** |
| `signin.code_refused`, reason `rate_limited` | Details `limit` says which limit: `resend`, a new code asked for within 60 seconds of the last one; `email`, 3 codes to one address; `ip`, 60 code requests from one IP; `check_ip`, 180 code checks from one IP (the parent sees "Too many tries. Wait a few minutes and request a new code."). The last three count 15 minutes back. For `email`, `ip` and `check_ip`, a full window is recorded once: the first refused request writes the row, and later ones in the same window write nothing | `resend`: wait 60 seconds. The others: wait up to 15 minutes, until the oldest request in the window is 15 minutes old |
| The sign-in page says "We couldn't reach the portal just then. Please try again in a moment." and there's no audit row | More than 20 code requests, or 20 code checks, from one IP in a minute: the portal turns them away before they are counted or recorded | Wait a minute |
| `signin.code_refused`, reason `mail_failed`, with `detail: "mail_not_working"`, and no `mail.failed` row | Mail isn't set up, or its settings haven't had a successful test email since they were saved, so nothing was sent | **Mail** in the staff menu (Admins only): **Send test email** |
| `signin.code_refused`, reason `mail_failed` with no `detail`, and a `mail.failed` row | Microsoft 365 or SMTP refused the message; the `mail.failed` row has the provider's error | For `ErrorAccessDenied`, rerun section 4 step 3 and wait up to 2 hours; staff see the same error on the staff home page |
| `/sign-in` says "Parent sign-in isn't available yet." | Mail settings aren't saved, or haven't had a successful test since they changed | **Mail** in the staff menu (Admins only): **Send test email** |
| Parent `signin.refused`, reason `family_not_enabled` | The parent was in, or chose, a family that isn't one of their enabled families. Usually the family's row was disabled while they were signed in: they are sent back to choose a family, and Details names the one they lost. With no family in Details, the chooser was sent something that isn't a family ID | Nothing, if the link was closed on purpose. Otherwise see the first row: the person's page under **Parents** says why the link is closed |
| Parent `signin.refused`, reason `address_changed` (the parent sees "That code didn't work.") | The person's email address was changed (by a roster refresh, by staff or by the parent) at the moment they entered a code that was sent to the old address | Nothing: they sign in with the new address |
| "Too many tries. Wait a few minutes and request a new code." | 180 code checks from one IP in 15 minutes | Wait 15 minutes |
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
| The staff home says "QuickBooks needs attention" with "The roster hasn't been refreshed from QuickBooks in more than 2 days." | The worker isn't running | `docker ps`, then `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d worker` |
| The staff home says "The QuickBooks connection couldn't be refreshed: Intuit no longer accepts this connection. Connect QuickBooks again." | The connection lapsed or was revoked at Intuit | Go through step 2 of the QuickBooks steps again |
| The staff home says "The last roster refresh failed: The parent sign-ins couldn't be brought up to date, so the roster was left as it was. (reconcile_failed)" (the roster pages say the same after "The latest try failed:") | The step that works out who can sign in failed inside the refresh | The roster and who can sign in are as they were before the refresh. Read `docker logs booster-rocket-app` for a line like `[roster] reconcile failed { name: 'DrizzleQueryError', code: '23505', constraint: 'parent_email_uq' }` (the error's class name, the database's SQLSTATE code and the constraint; never the message or an address) and report it |
| `/sign-in` says "Parent sign-in isn't available yet." after parent sign-ins were switched off | Sign-ins are off, so nobody can sign in (the audit shows `signin.code_refused`, reason `signins_off`) | **Parent sign-ins** in the staff menu, **Change**, step 2: **Switch parent sign-ins on**. Welcome emails went off with them; switch them on again in step 3 if wanted |
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
4. Optional: delete the data with `docker volume rm booster-rocket-pgdata`, and the images with
   `docker image rm booster-rocket-app:current booster-rocket-app:previous`.
