# Booster Rocket proof of concept on linuxdev: runbook

Follow this top to bottom, with one exception: sign-in is set up on the site's `/setup` page, which only
exists after the first deploy (section 7). Section 4 part A (creating the parent tenant in Azure) can be
done before deploying. Section 3 and section 4 parts B to E happen on the setup page after the first
deploy. Each section is numbered steps. Anything in `monospace` is typed or
pasted exactly. Dashboard click paths were checked against Microsoft Learn and Cloudflare's
documentation on 2026-11-08; the sources are listed under each section. If a screen no longer matches,
trust the screen and note it in the Results table.

## 1. What this is

This puts Booster Rocket on the Linux host `linuxdev` at https://portaltest.rhinoautomator.com, behind
a Cloudflare tunnel (and, optionally, Cloudflare Access), so you can prove that staff sign-in (the band's Entra
tenant or Google), parent sign-in (Entra External ID) and the audit log work for real. It holds **test data
only**; no real families use it.

Two sign-in doors exist. Staff use `/staff/sign-in`; parents use `/sign-in`. If Cloudflare
Access is set up, it sits in front of both, so testers sign in twice (an emailed code, then the portal's own
sign-in). For this proof of concept the owner chose to skip Access rather than manage a list of tester
emails (see section 6 B, which is optional), so testers sign in once, at the portal's own sign-in.

Sign-in is not configured in files. After the first deploy you open `/setup`, enter a one-time setup
code that `deploy.sh` prints, and set up staff sign-in, parent sign-in and the first Admin on that page
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

After setup, Admins can change sign-in under **Settings** > **Sign-in**. **Replace certificate** downloads
a new certificate. The old one keeps working until **Check and switch** succeeds; after that you can remove
the old certificate in Entra. The staff home warns Admins 30 days before a certificate expires; use
Replace certificate under Settings → Sign-in. (Google still uses a client secret, entered as before.)

Sources: Register an application in Microsoft Entra ID
(https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app); Add a redirect URI
(https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri); Add credentials,
including certificates
(https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).

## 4. Parent sign-in (Entra External ID)

Parents sign in through a separate *external tenant* so their accounts never mix with staff.

**A. Create the external tenant** (needs the Tenant Creator role on the band's Azure subscription)

1. In https://entra.microsoft.com (signed in to the band's tenant) browse to **Entra ID** > **Overview** >
   **Manage tenants** and select **Create**.
2. Select **External**, then **Continue**. Choose **Use Azure Subscription** (not the 30-day trial,
   unless you only want a throwaway).
3. **Basics** tab: enter a **Tenant Name** (for example `Band Parents Test`) and a **Domain Name**
   (for example `bandparentstest`).
4. **Country/Region:** **United States**. This cannot be changed later.
5. Select **Next: Add a subscription**; choose the band's subscription and a resource group (use
   **Create new** if there is none). Select **Next: Review + Create**, then **Create**. It can take up to
   30 minutes (watch the **Notifications** bell).
6. Switch to the new tenant with the **Settings** icon > **Directories + subscriptions** > **Switch**. Under
   **Tenant overview** copy the **Tenant ID** and the **Primary domain** (the part before `.onmicrosoft.com`
   is the tenant name used below).

**B to E. Everything else is Step 2 of the setup page.** The tenant itself must be created by hand (part
A); after that, follow **Step 2** of the setup page, or run `New-BoosterRocketParentApp.ps1`, which
registers the portal in the external tenant, adds the certificate, and also turns sign-up off (the same
thing as part D). On Windows, run `Unblock-File .\New-BoosterRocketParentApp.ps1` first.
The page builds the discovery address itself from the tenant subdomain and ID, and checks it (and the
certificate) with Microsoft before it saves anything. Parts B to E below are what those steps do,
for reference and for doing it by hand.

**B. Register the portal in the external tenant** (still switched into the external tenant)

1. **Entra ID** > **App registrations** > **New registration**. **Name:** `Booster Rocket (parents)`.
   **Supported account types:** **Single tenant only**. Use exactly this name: the script finds the app by it.
2. **Redirect URI:** platform **Web**, exactly:
   ```
   https://portaltest.rhinoautomator.com/api/auth/parent/callback/parent-oidc
   ```
3. **Register.** Copy **Application (client) ID** (the client ID for Step 2).
4. On the setup page (Step 2), select **Download certificate (.cer)**; it saves
   `booster-rocket-parents.cer`. In Entra, **Certificates & secrets** > **Certificates** > **Upload
   certificate**, and add that file. No secret is needed.
5. External tenants require an administrator to consent for everyone: under **Manage** select **API
   permissions**, **Grant admin consent for <tenant name>**, **Yes**, **Refresh**, and check **Granted for
   <tenant name>** shows under **Status**.

**C. Create the user flow (email one-time passcode)**

1. **Entra ID** > **External Identities** > **User flows** > **New user flow**.
2. **Name:** `Booster Rocket parents`. Use exactly this name: the script finds the flow by it. Under **Identity providers** tick **Email Accounts** and choose **Email
   one-time passcode**. (If the option is greyed out or missing, first check **External Identities** >
   **All identity providers** > **Email one-time passcode** is enabled.) Pick any user attributes
   (the defaults are fine), **OK**, **Create**.
3. Open the new flow, in the left menu under **Use** select **Applications**, **Add application**, pick
   `Booster Rocket (parents)`, **Select**.

**D. Turn sign-up off.** You cannot do this in the admin center; Microsoft documents it as a Microsoft
Graph call. With sign-up on, a stranger could create a parent account. `New-BoosterRocketParentApp.ps1`
does this for you; the steps below are the manual fallback.

1. Copy the app's **Application (client) ID** from the user flow's **Applications** list (same value as in B3).
2. Using any tool that can call Microsoft Graph as a signed-in admin of the *external* tenant (for example
   Graph Explorer at https://developer.microsoft.com/graph/graph-explorer; consent to
   `EventListener.ReadWrite.All` when asked), find the flow's ID by listing the flow for that application:
   see "List the user flow associated with a specific application ID" at
   https://learn.microsoft.com/en-us/graph/api/identitycontainer-list-authenticationeventsflows#example-4-list-user-flow-associated-with-specific-application-id
3. Send `PATCH https://graph.microsoft.com/beta/identity/authenticationEventsFlows/{user-flow-id}` with
   this body (this is the exact request Microsoft documents):
   ```json
   {
     "@odata.type": "#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow",
     "onInteractiveAuthFlowStart": {
       "@odata.type": "#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp",
       "isSignUpAllowed": false
     }
   }
   ```
4. Confirm by re-reading the flow: `isSignUpAllowed` must be `false`.

**The script and the manual steps use the same names.** `New-BoosterRocketParentApp.ps1` looks for the app
`Booster Rocket (parents)` and the user flow `Booster Rocket parents`, and reuses what it finds (checking
the settings, and turning sign-up off) instead of creating duplicates. If you already did parts B and C by
hand under these names, running the script is safe: it fixes the settings and adds the certificate, and it
creates and prints no secret. It prints the **Tenant ID**, **Client ID**, **Tenant subdomain** and the
certificate's thumbprint and expiry. It keeps existing certificates on the app; if Microsoft does not return
them, or one has expired, it stops with a message to fix it by hand. (If two apps share the name it stops
and asks you to delete the extra one.)

**E. Enter the values in Step 2 of the setup page** (not in `.env.poc`). The page asks for:
```
Tenant subdomain:         <tenant-name>   (the part before .onmicrosoft.com, from part A6)
Directory (tenant) ID:    <tenant ID from part A6>
Application (client) ID:  <application (client) ID from B3>
```
Then select **Check and save**. There is no secret and no expiry date: the certificate from B4 stands in
for them.
The page builds the discovery address itself
(`https://<tenant-name>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration`), so there is
nothing to paste or test in a browser. It fetches that address and trial-signs-in with the certificate
before saving anything; a wrong subdomain or tenant ID is reported in plain words and nothing is saved.

**Then Step 3 of the setup page:** enter the email address of the first Admin (the one the Microsoft or
Google account signs in with), sign in, and setup closes. That person is now an Admin.

Sources: Create an external tenant
(https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-create-external-tenant-portal);
Register an application, incl. admin consent for external tenants
(https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app); Create a sign-up and
sign-in user flow
(https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-user-flow-sign-up-sign-in-customers);
Add your application to the user flow
(https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-user-flow-add-application); Disable
sign-up in a user flow
(https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-disable-sign-up-user-flow); Update
authenticationEventsFlow
(https://learn.microsoft.com/en-us/graph/api/authenticationeventsflow-update); discovery document
format (https://learn.microsoft.com/en-us/entra/identity-platform/security-tokens#token-endpoints-and-issuers).

## 5. Test parents

1. Switch to the external tenant. **Entra ID** > **Users** > **New user** > **Create new external user**.
2. Under **Identities** set **Sign-in method** to **Email** and **Value** to the parent's real email
   address (you must be able to read its inbox to get the sign-in code). Enter a **Display name**. Select
   **Review + create**. Create **two** users: parent one and parent two.
3. Open parent one (**Entra ID** > **Users**, select them) and copy the **Object ID** from the user's
   overview page. Parent two gets no guardian row on purpose (checklist step 7).
4. **Wait until the first deploy in section 7 has succeeded** (the image and database tables the seed
   needs do not exist before that). Then, on linuxdev:
   ```bash
   cd ~/booster-rocket
   docker compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/seed-poc-guardian.mjs --name "<name>" --email "<email>" --object-id "<object id>" --family POC-FAMILY-1
   ```
   Success prints `seeded guardian <id>`. It refuses unless `APP_URL` contains `portaltest`. Running it
   twice with the same Object ID prints "A guardian with that object id already exists."

Sources: Manage user accounts for consumers and business customers
(https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-manage-customer-accounts); How to
create, invite, and delete users
(https://learn.microsoft.com/en-us/entra/fundamentals/how-to-create-delete-users). (The Object ID
location on the user page is the standard Entra user overview; those pages do not spell it out.)

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
   step 4 (the seed).
7. **Need a code later?** `scripts/poc/setup-code.sh` prints a new one (the old code stops working) while
   setup is open. **Nobody can sign in** (for example, a certificate or Google client secret expired)?
   `scripts/poc/reopen-setup.sh` reopens setup and prints a code. Stored sign-in values are kept and
   existing Admins stay Admins.

## 8. The test checklist

Run these in order, in a private browser window. Record each outcome in section 10.

- [ ] 1. Visit https://portaltest.rhinoautomator.com: the portal's sign-in page shows directly. (Only if Cloudflare Access is set up, section 6 B, it first asks for an email code.)
- [ ] 2. Finish setup at `/setup` (Step 3 signs you in as Admin) -> staff home, as Admin.
- [ ] 3. Set the club name and color -> they show on every page.
- [ ] 4. Parent: sign in at `/sign-in` as the seeded test parent -> parent home (not the refusal page).
- [ ] 5. Audit log shows: `admin.bootstrap`, `staff.bind`, staff `signin`, parent `signin`, `parent.object_id_set`, `guardian.activate`, `settings.club.save`, and from setup `setup.code.issue`, `setup.unlock`, `setup.provider.save`, `setup.admin_email.save`, `setup.finish`, and from the Microsoft certificate steps `certificate.create` and `certificate.activate` (`certificate.retire` appears later, when **Replace certificate** retires the old one). Also `setup.unlock.refused` after entering a wrong code, `setup.provider.remove` after removing a sign-in provider, and `setup.reopen` after running `scripts/poc/reopen-setup.sh`.
- [ ] 6. Sign out at both doors -> both `signout` entries appear.
- [ ] 7. The second External ID user (no guardian row) -> refusal page; audit shows `signin.refused` with reason `no_guardian`.
- [ ] 8. `deploy.sh` run a second time with no changes completes and keeps the app healthy; `--rollback` returns to the previous image and the app stays healthy.
  After a no-change redeploy, `previous` and `current` are the same image, so `--rollback` only exercises the mechanism; a real rollback test needs a real new commit.

**Reading the audit log:** sign in as staff at `/staff/sign-in` (setup signs you in the first time) and choose **Audit** in the top menu (it
shows only to people who hold the audit-read permission; Admin does). Each row shows time, door
(staff, parent or system), who, the action, and details. A refusal's reason is in the details as
`reason`: each row has a **Details** line you can open, showing the saved before/after values
(for example `{"reason":"no_guardian"}`). Times show in your own device's time zone; the database stores them in UTC (hover a time to see the exact UTC instant; `psql` output follows the server's zone, Central). The person always sees the same
refusal page; the reason is only in the log. If the page itself is unavailable, read the log from the
database on linuxdev:
```bash
cd ~/booster-rocket
docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "select at, door, actor_label, action, before, after from audit_log order by at desc limit 20;"
```

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Parent sees the refusal page; audit `signin.refused` (door parent), reason `missing_object_id` | The app never saved this parent's Object ID: the token could not be verified (look for a `parent.object_id_unverified` row just before it) | Read the `parent.object_id_unverified` reason below; fix that; sign in again |
| `signin.refused`, reason `no_guardian` | No guardian row has this Object ID | Expected for parent two. For a real tester: copy the Object ID from the external tenant user and run the seed (section 5) |
| `signin.refused`, reason `disabled` | The guardian row exists but its status is disabled | Test data: set it back with `docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "update guardian set status='invited' where email='<email>';"` (this SQL fix bypasses the audit log, so it is acceptable only for test data) |
| Staff `signin.refused` (door staff; staff refusals carry no reason, so Details is empty) | The Microsoft account is not a known staff member and is not the first Admin email entered in Step 3 of setup | Sign in with that email, or have an Admin add the person first (**Staff** menu) |
| `parent.object_id_unverified`, reason `subject_mismatch` | The ID token's subject differs from the account being signed in | Sign out everywhere, clear cookies, try again; if it repeats, report it (should not happen) |
| `parent.object_id_unverified`, reason `invalid_token:...` (for example `invalid_token:ERR_JWT_CLAIM_VALIDATION_FAILED:iss` or `:aud`, or `ERR_JWT_EXPIRED`) | Wrong issuer or audience, or an expired token. `iss`: discovery URL is for another tenant; `aud`: the client ID entered is not the parent app's client ID | Re-check the parent sign-in values (**Settings** > **Sign-in**, or `scripts/poc/reopen-setup.sh` and Step 2 of the setup page) |
| `parent.object_id_unverified`, reason `missing_oid` | The token verified but has no `oid` claim | Check the app registration is in the **external** tenant and sign-in uses its user flow; report the finding (this is the open risk in the spec) |
| `parent.object_id_unverified`, reasons `no_id_token`, `discovery_failed`, `verifier_unavailable`, `user_missing` | No ID token returned; the discovery URL cannot be fetched from linuxdev; or the account row vanished | Open the discovery URL in a browser; check linuxdev has internet access; check admin consent (section 4 B5) |
| `parent.object_id_conflict` in audit | The same account came back with a different Object ID | Test data: use a different external user; report it |
| Microsoft error "AADSTS50011: The redirect URI ... does not match" | Redirect URI in the app registration differs from the one the portal sends | Staff: `https://portaltest.rhinoautomator.com/api/auth/staff/callback/microsoft`; parent: `https://portaltest.rhinoautomator.com/api/auth/parent/callback/parent-oidc`. Platform must be **Web**; no trailing slash |
| The setup page refuses the Microsoft tenant ID | It is `common`, `organizations`, `consumers` or something that is not a GUID | Use the **Directory (tenant) ID** GUID from the band's tenant Overview page; also set the registration to **Single tenant only** |
| The staff app registration was created as multi-tenant | Wrong **Supported account types** choice | Entra > the app > **Authentication** > **Supported account types** > **Single tenant only** |
| A stranger can create a parent account in External ID | Sign-up left on in the user flow | Redo section 4 D (or run `New-BoosterRocketParentApp.ps1`) and confirm `isSignUpAllowed` is `false` |
| Setup code does not work | It is wrong, was replaced by a newer one, was slowed down by too many wrong tries, or is void | Run `scripts/poc/setup-code.sh` for a fresh code and use that one |
| Microsoft doesn't have this certificate on the app yet (`AADSTS700027`) | The `.cer` was not uploaded to the app registration, or Microsoft has not picked it up yet | Upload the `.cer` under **Certificates & secrets** > **Certificates** (or run the script), wait a minute, and try again |
| The server's clock looks wrong, so Microsoft refused the certificate (`AADSTS700024`) | The time on linuxdev is off | Fix the time on linuxdev, then try again |
| The tenant blocks client secrets (`CredentialTypeNotAllowedAsPerAppPolicy`) | The tenant's "Block password addition" app policy, which stops apps from getting client secrets, refused the request | Nothing needs changing: this is why Microsoft sign-in uses certificates. Use the certificate steps in sections 3 and 4 (Google still uses a secret) |
| Nobody can sign in (for example, a certificate or Google client secret expired) | Sign-in values need replacing | Run `scripts/poc/reopen-setup.sh`, enter the code at `/setup`, and re-enter the values. Existing Admins stay Admins |
| Sign-in shows "not set up" after `.env.poc` was changed or replaced | `SETTINGS_ENCRYPTION_KEY` changed, so the stored secrets cannot be read | Put the old key back if you have a backup; otherwise run `scripts/poc/reopen-setup.sh` and re-enter the secrets |
| Step 3 says it is a different account | You are signed in to Microsoft as someone other than the Admin email you entered | Sign out of Microsoft, then sign in as the Admin email |
| Browser shows Cloudflare 502 | `cloudflared` cannot reach `booster-rocket-app:3000`: the edge network was not added to cloudflared, cloudflared was not recreated, or the app is unhealthy | `docker network inspect booster-rocket-edge` must list both `cloudflared` and `booster-rocket-app`; if not, redo section 2 steps 3-4. Then `docker ps` for `(healthy)` and `docker logs booster-rocket-app` |
| Form buttons or sign-in fail with a server action or origin/forbidden error | HTTP Host Header is set in the tunnel route, or `APP_URL` is wrong | Clear the HTTP Host Header (section 6 A5); make `APP_URL=https://portaltest.rhinoautomator.com` exactly, then recreate the app |
| Deploy or migrate fails with a database password error after re-running setup | `.env.poc` was deleted and regenerated (new `DB_PASSWORD`) | See the note at the end of section 2 |
| Only if Access is set up: Cloudflare never emails a code | The email is not in the Allow policy, or One-time PIN is not enabled on the application | Section 6 B steps 1-3; check spam |

## 10. Results

Fill one row per checklist step each time you run it.

| Date | Commit | Step | Pass/Fail | Notes |
|---|---|---|---|---|
| | | 1 | | |
| | | 2 | | |
| | | 3 | | |
| | | 4 | | |
| | | 5 | | |
| | | 6 | | |
| | | 7 | | |
| | | 8 | | |

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
