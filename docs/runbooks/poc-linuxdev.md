# Booster Rocket proof of concept on linuxdev: runbook

Follow this top to bottom, with one exception: the `/setup` page only exists after the first deploy (section 7).
Sign-in and outgoing mail are set up on the setup page after the first deploy (sections 3 and 4). Each section is numbered steps. Anything in `monospace` is typed or
pasted exactly. Dashboard click paths were checked against Microsoft Learn and Cloudflare's
documentation on 2026-11-08; the sources are listed under each section. If a screen no longer matches,
trust the screen and note it in the Results table.

## 1. What this is

This puts Booster Rocket on the Linux host `linuxdev` at https://portaltest.rhinoautomator.com, behind
a Cloudflare tunnel (and, optionally, Cloudflare Access), so you can prove that staff sign-in (the band's Entra
tenant or Google), parent sign-in (a 6-digit code the portal emails from
`webmaster@fznband.org`) and the audit log work for real. It holds **test data
only**; no real families use it.

Two sign-in doors exist. Staff use `/staff/sign-in`; parents use `/sign-in`. If Cloudflare
Access is set up, it sits in front of both, so testers sign in twice (an emailed code, then the portal's own
sign-in). For this proof of concept the owner chose to skip Access rather than manage a list of tester
emails (see section 6 B, which is optional), so testers sign in once, at the portal's own sign-in.

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
   scripts/poc/setup.sh
   ```
   It is safe to run again; it never overwrites an existing `.env.poc`. (If an older `.env.poc` has no
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
  and 4) again. After the deploy, re-run the seed in section 5 (the guardian rows are gone).

## 3. Staff sign-in (the band's Entra tenant, or Google)

Do this after the first deploy (section 7). Open https://portaltest.rhinoautomator.com/setup, enter the
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
certificate under Settings → Sign-in. (Google still uses a client secret, entered as before.)

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

The script's mail part has not yet been run against a real tenant; the first run is part of this proof of concept.
Record what actually happens in section 10.

1. Do section 3 first: this uses the staff app.
2. On a Windows PC with PowerShell 7, install the Exchange Online module once:
   `Install-Module ExchangeOnlineManagement -Scope CurrentUser`
3. On the setup page, Step 2 (Outgoing mail), open **Microsoft 365: let the app send as one mailbox**, download
   `New-BoosterRocketStaffApp.ps1` again (it carries the current certificate), run `Unblock-File` on it, then run
   `./New-BoosterRocketStaffApp.ps1 -TenantId <band tenant ID> -SetUpMail -Mailbox webmaster@fznband.org`, signed in
   as an Exchange administrator. It reuses the staff app and adds the mail permission. (The same steps by hand are
   under that heading on the setup page.) The script:
   - needs `-Mailbox` to be an email address, and stops if Exchange Online has no such mailbox;
   - asks you to sign in to Exchange Online, and stops if you sign in to a different tenant from the one you gave
     with `-TenantId` (run it again and sign in as an administrator of the band's tenant);
   - creates a management scope named `Booster Rocket mail sender` that holds only that mailbox (matched by its
     primary address), and gives the app the `Application Mail.Send` role on that scope;
   - checks that every Exchange Online assignment that lets the app send mail is limited to that scope. If it finds
     others, it stops and names them. It never removes anything itself: remove the extras in Exchange Online (the
     message gives the command that lists them), then run it again;
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

The old parents tenant (`fznbandparents`) and its app aren't used any more. Delete them whenever you like; the
portal never deletes anything in a tenant, and nothing here does it for you.

Sources: Role Based Access Control for Applications in Exchange Online
(https://learn.microsoft.com/exchange/permissions-exo/application-rbac); user: sendMail
(https://learn.microsoft.com/graph/api/user-sendmail).

## 5. Test parents

1. **Wait until the first deploy in section 7 has succeeded.** Then, on linuxdev, seed parent one:
   ```bash
   cd ~/booster-rocket
   docker compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/seed-poc-guardian.mjs --name "<name>" --email "<email you can read>" --family POC-FAMILY-1
   ```
   Success prints `seeded guardian <id>`. It refuses unless `APP_URL` contains `portaltest`. Running it again with
   the same email and family prints "That person is already a guardian in that family." The same email with
   `--family POC-FAMILY-2` adds a second family to the same person.
2. Parent two is any other address you can read. It gets no guardian row on purpose (checklist step 7).

## 6. Cloudflare

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

## 7. Deploy

1. On linuxdev:
   ```bash
   cd ~/booster-rocket
   scripts/poc/deploy.sh
   ```
   It refuses if the checkout has local changes, pulls `main`, builds the image, runs the database
   migrations, recreates the app and waits up to 120 seconds for it to become healthy. The first build
   takes several minutes.
2. **Success** is the last line `Deployed <short commit>.` and exit code 0 (`echo $?`). Also:
   `docker ps --filter name=booster-rocket-app` shows `(healthy)`. While setup is still open, a line
   `Setup code: XXXX-XXXX-XXXX` is printed just before it. Enter that code at `/setup`. Once setup is
   finished, no code is printed.
3. If it stops, the exit code says why:

   | Code | Meaning | What to do |
   |---|---|---|
   | 2 | Refused: local changes, `.env.poc` missing or not mode 600, or another deploy is running | Read the message; fix; run again |
   | 3 | Migrations failed; running app untouched | Read the migrate output above the message; check `DB_PASSWORD` (end of section 2) |
   | 4 | App did not become healthy in time | `docker logs booster-rocket-app`; then `scripts/poc/deploy.sh --rollback` if needed |
   | 5 | Nothing to roll back to | None (nothing was changed) |
   | 6 | `git pull` failed | Check network and SSH key; nothing was changed |
   | 7 | Build failed; running app untouched | Read the build output |
4. **Roll back** to the previous image (database changes are *not* undone):
   ```bash
   scripts/poc/deploy.sh --rollback
   ```
5. **Logs:** `docker logs booster-rocket-app` (add `--tail 100` or `-f`). Database:
   `docker compose -f docker-compose.poc.yml --env-file .env.poc logs db`.
6. After the first successful deploy, finish setup at `/setup` (sections 3 and 4), then do section 5
   step 1 (the seed).
7. **Need a code later?** `scripts/poc/setup-code.sh` prints a new one (the old code stops working) while
   setup is open. **Nobody can sign in** (for example, a certificate or Google client secret expired)?
   `scripts/poc/reopen-setup.sh` reopens setup and prints a code. Stored sign-in values are kept and
   existing Admins stay Admins.

## 8. The test checklist

Run these in order, in a private browser window. Record each outcome in section 10.

- [ ] 1. Visit https://portaltest.rhinoautomator.com: the portal's sign-in page shows directly. (Only if Cloudflare Access is set up, section 6 B, it first asks for an email code.)
- [ ] 2. Finish setup at `/setup` (Step 3 signs you in as Admin) -> staff home, as Admin.
- [ ] 3. Set the club name and color -> they show on every page.
- [ ] 4. Parent: at `/sign-in`, enter the seeded parent's email, get the code from `webmaster@fznband.org`, enter it -> parent home (with two families, the family chooser first).
- [ ] 5. Audit log shows: `admin.bootstrap`, `staff.bind`, staff `signin`, `signin.code_sent`, parent `signin`, `guardian.activate`, `settings.club.save`, and from setup `settings.mail.save`, `settings.mail.test`, `setup.code.issue`, `setup.unlock`, `setup.provider.save`, `setup.admin_email.save`, `setup.finish`, and from the Microsoft certificate steps `certificate.create` and `certificate.activate` (`certificate.retire` appears later, when **Check and switch** after **Replace certificate** retires the old one, and `certificate.discard` after **Discard replacement**). Also `setup.unlock.refused` after entering a wrong code, `setup.provider.remove` after removing a sign-in provider, and `setup.reopen` after running `scripts/poc/reopen-setup.sh`.
- [ ] 6. Sign out at both doors -> both `signout` entries appear.
- [ ] 7. Parent two's address -> the same "If this email belongs to a family…" message, no email arrives, and the audit shows `signin.code_refused` with reason `unknown_email`.
- [ ] 8. `deploy.sh` run a second time with no changes completes and keeps the app healthy; `--rollback` returns to the previous image and the app stays healthy.
  After a no-change redeploy, `previous` and `current` are the same image, so `--rollback` only exercises the mechanism; a real rollback test needs a real new commit.
- [ ] 9. From PowerShell, confirm the app can't send as any other mailbox: `Test-ServicePrincipalAuthorization -Identity <staff app Object ID> -Resource <another mailbox>` shows `InScope` `False` for Application Mail.Send.

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

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `signin.refused`, reason `no_enabled_guardian` (after the code was accepted) | The guardian row exists but its status is disabled | Test data: set it back with `docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "update guardian set status='invited', disabled_reason=null where parent_id=(select id from parent where email='<email>');"` (this SQL fix bypasses the audit log, so it is acceptable only for test data) |
| A parent never gets a code; audit `signin.code_refused`, reason `unknown_email` | No person has that email | Seed them (section 5); addresses are matched trimmed and lowercased |
| `signin.code_refused`, reason `no_enabled_guardian` | All of the person's guardian rows are disabled | Test data: re-enable the row (see the row above) |
| `signin.code_refused`, reason `rate_limited` | 3 codes to one address, or 10 requests from one IP, in 15 minutes, or a resend within 60 seconds | Wait 15 minutes |
| `signin.code_refused`, reason `mail_failed`, and a `mail.failed` row | Microsoft 365 or SMTP refused the message; the `mail.failed` row has the provider's error | For `ErrorAccessDenied`, rerun section 4 step 3 and wait up to 2 hours; staff see the same error on the staff home page |
| `/sign-in` says "Parent sign-in isn't available yet." | Mail settings aren't saved, or haven't had a successful test since they changed | **Settings** > **Mail** (Admins only): **Send test email** |
| "Too many tries. Wait a few minutes and request a new code." | 30 code checks from one IP in 15 minutes | Wait 15 minutes |
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
| Form buttons or sign-in fail with a server action or origin/forbidden error | HTTP Host Header is set in the tunnel route, or `APP_URL` is wrong | Clear the HTTP Host Header (section 6 A5); make `APP_URL=https://portaltest.rhinoautomator.com` exactly, then recreate the app |
| Deploy or migrate fails with a database password error after re-running setup | `.env.poc` was deleted and regenerated (new `DB_PASSWORD`) | See the note at the end of section 2 |
| Only if Access is set up: Cloudflare never emails a code | The email is not in the Allow policy, or One-time PIN is not enabled on the application | Section 6 B steps 1-3; check spam |

## 10. Results

Fill one row per checklist step each time you run it.

| Date | Commit | Step | Pass/Fail | Notes |
|---|---|---|---|---|
| 2026-11-09 | 994f231 | 1 | Pass | Cloudflare Access skipped by choice; the setup page showed directly. |
| 2026-11-09 | 994f231 | 2 | Pass | Staff Microsoft sign-in with a certificate (the band tenant blocks client secrets: `CredentialTypeNotAllowedAsPerAppPolicy`). The staff script created the app, granted consent and added the certificate; a re-run reused the app and found the certificate already there. Signed in as webmaster@fznband.org and was made Admin. |
| 2026-11-09 | 994f231 | 3 | Pass | Name "FZN Band Boosters", color #005102. Short name still the default "BR"; set it under Club. |
| | | 4 | Not run | Not run: waiting on outgoing mail (section 4). |
| 2026-11-09 | 994f231 | 5 | Partial | Present: `setup.code.issue`, `setup.unlock`, `certificate.create` (staff, plus a pending parent certificate made by downloading the parent script), `certificate.activate`, `setup.provider.save`, `setup.admin_email.save`, staff `signin`, `admin.bootstrap`, `setup.finish`, `settings.club.save`, `signout`. No `staff.bind`: the first Admin is created already bound, so it only appears for invited staff. Parent rows wait on step 4. |
| 2026-11-09 | 994f231 | 6 | Partial | Staff sign-out recorded. Parent sign-out waits on step 4. |
| | | 7 | Not run | Not run: waiting on outgoing mail (section 4). |
| 2026-11-09 | 994f231 | 8 | Pass | Redeploy kept `previous` and stayed healthy; `--rollback` returned to it and stayed healthy (both images were the same commit, so this tested the mechanism). |

Findings from the 2026-11-09 run, all fixed on `main`:

- **The band tenant blocks client secrets,** so Microsoft sign-in now uses app-generated certificates (no secret anywhere).
- **Deploys on Docker 29:** the first redeploy failed while tagging the rollback copy, because the old image's record was gone once `current` moved to the new build. Fixed in `e58b69a`: the copy is now kept before the build, and a tagging failure can't stop a deploy. Because `deploy.sh` updates itself during its own `git pull`, the first deploy after a script change still runs the old copy.
- **The scripts created a new app on every run,** because Microsoft's filter-by-name lookup returned nothing. Fixed in `994f231`: the scripts now list the apps and match the name themselves. Delete any duplicate apps by hand.
- **Windows blocks downloaded scripts:** run `Unblock-File` first. Browsers also save a second download as `name (1).ps1`, so delete the old file before downloading again.

2026-11-10: an account an admin creates in External ID always has a password, so External ID can't give parents email-code-only sign-in with sign-up off. Parents now get codes from the portal itself (spec 2026-11-10).

Get the commit with `git -C ~/booster-rocket rev-parse --short HEAD` (the deploy script prints it too).

Record results from the development checkout (on Windows), not by committing on linuxdev: a local commit there makes the next `git pull --ff-only` fail (exit 6) or trips the clean-tree check (exit 2).

## 11. Removing the proof of concept

Do these in order. Removing the network first would break cloudflared's next start (including the weekly
update) and take the tunnel down for n8n and CIPP.

1. Stop and remove the app:
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
