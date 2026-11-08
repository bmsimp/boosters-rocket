# Booster Rocket proof of concept on linuxdev: runbook

Follow this top to bottom. Each section is numbered steps. Anything in `monospace` is typed or
pasted exactly. Dashboard click paths were checked against Microsoft Learn and Cloudflare's
documentation on 2026-11-08; the sources are listed under each section. If a screen no longer matches,
trust the screen and note it in the Results table.

## 1. What this is

This puts Booster Rocket on the Linux host `linuxdev` at https://portaltest.rhinoautomator.com, behind
a Cloudflare tunnel and Cloudflare Access, so you can prove that staff sign-in (the band's Entra
tenant), parent sign-in (Entra External ID) and the audit log work for real. It holds **test data
only**; no real families use it.

Two sign-in doors exist. Staff use `/staff/sign-in`; parents use `/sign-in`. Cloudflare Access sits in
front of both, so testers sign in twice (an emailed code, then the portal's own sign-in).

## 2. First-time setup on linuxdev

Do this over SSH as user `brian`.

1. Get the code:
   ```bash
   git clone git@github.com:bmsimp/booster-rocket.git ~/booster-rocket
   cd ~/booster-rocket
   ```
2. Run the setup script. It creates the Docker network `booster-rocket-edge` and a private `.env.poc`
   file with a freshly generated `BETTER_AUTH_SECRET` and `DB_PASSWORD`:
   ```bash
   scripts/poc/setup.sh
   ```
   It is safe to run again; it never overwrites an existing `.env.poc`.
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
4. **Pick a quiet time, then recreate cloudflared.** Recreating it briefly drops *every* site on this
   tunnel (n8n, the CIPP tracker, and anything else), usually for a few seconds to a minute.
   ```bash
   docker compose -f ~/n8n/docker-compose.yml up -d cloudflared
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
  the old file). Then re-enter the other values from sections 3 and 4.
- *Throw the data away (test data only):* stop the stack and delete the volume, then deploy again.
  ```bash
  cd ~/booster-rocket
  docker compose -f docker-compose.poc.yml --env-file .env.poc down
  docker volume rm booster-rocket-pgdata
  ```
  The new `.env.poc` has fresh secrets only: the Microsoft values from sections 3 and 4
  (`STAFF_ENTRA_*`, `PARENT_OIDC_*`) and `BOOTSTRAP_ADMIN_EMAIL` are blank. Re-enter all of them
  *before* you deploy. After the deploy, re-run the seed in section 5 (the guardian rows are gone).
  Staff and parent accounts are re-created at next sign-in.

## 3. Staff sign-in (the band's Entra tenant)

Use an account in the band's Entra tenant that can register applications (you are Global Administrator).

1. Sign in to https://entra.microsoft.com. If you have several tenants, use the **Settings** icon at the
   top and switch to the band's tenant.
2. Browse to **Entra ID** > **App registrations** and select **New registration**.
3. **Name:** `Booster Rocket staff (portaltest)`.
4. **Supported account types:** choose **Single tenant only - <your tenant>**.
5. **Redirect URI:** set the platform to **Web** and enter exactly:
   ```
   https://portaltest.rhinoautomator.com/api/auth/staff/callback/microsoft
   ```
   (If you skip it here: open the app, under **Manage** select **Authentication**, **Add Redirect URI**,
   choose **Web**, enter the URI above, **Configure**.)
6. Select **Register**. On the **Overview** page copy:
   - **Application (client) ID** -> `STAFF_ENTRA_CLIENT_ID`
   - **Directory (tenant) ID** -> `STAFF_ENTRA_TENANT_ID`. This must be the GUID (like
     `00aa00aa-bb11-cc22-dd33-44ee44ee44ee`), never the words `common`, `organizations` or `consumers`.
7. Under **Manage** select **Certificates & secrets** > **Client secrets** > **New client secret**. Add a
   description, choose an expiration (Microsoft recommends under 12 months), select **Add**. Copy the
   secret **Value** now (not the Secret ID); it is never shown again -> `STAFF_ENTRA_CLIENT_SECRET`.
8. On linuxdev edit `~/booster-rocket/.env.poc` (for example `nano ~/booster-rocket/.env.poc`) and fill:
   ```
   STAFF_ENTRA_TENANT_ID=<directory (tenant) ID GUID>
   STAFF_ENTRA_CLIENT_ID=<application (client) ID>
   STAFF_ENTRA_CLIENT_SECRET=<secret value>
   BOOTSTRAP_ADMIN_EMAIL=<your band email address>
   ```
   `BOOTSTRAP_ADMIN_EMAIL` is the address that becomes the first Admin when you first sign in. It must
   be the same address the Microsoft account signs in with. Leave `APP_URL` as
   `https://portaltest.rhinoautomator.com`.

Sources: Register an application in Microsoft Entra ID
(https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app); Add a redirect URI
(https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri); Add a client secret
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

**B. Register the portal in the external tenant** (still switched into the external tenant)

1. **Entra ID** > **App registrations** > **New registration**. **Name:** `Booster Rocket parents (portaltest)`.
   **Supported account types:** **Single tenant only**.
2. **Redirect URI:** platform **Web**, exactly:
   ```
   https://portaltest.rhinoautomator.com/api/auth/parent/callback/parent-oidc
   ```
3. **Register.** Copy **Application (client) ID** -> `PARENT_OIDC_CLIENT_ID`.
4. **Certificates & secrets** > **Client secrets** > **New client secret** > **Add**; copy the **Value** ->
   `PARENT_OIDC_CLIENT_SECRET`.
5. External tenants require an administrator to consent for everyone: under **Manage** select **API
   permissions**, **Grant admin consent for <tenant name>**, **Yes**, **Refresh**, and check **Granted for
   <tenant name>** shows under **Status**.

**C. Create the user flow (email one-time passcode)**

1. **Entra ID** > **External Identities** > **User flows** > **New user flow**.
2. **Name:** `SignUpSignIn`. Under **Identity providers** tick **Email Accounts** and choose **Email
   one-time passcode**. (If the option is greyed out or missing, first check **External Identities** >
   **All identity providers** > **Email one-time passcode** is enabled.) Pick any user attributes
   (the defaults are fine), **OK**, **Create**.
3. Open the new flow, in the left menu under **Use** select **Applications**, **Add application**, pick
   `Booster Rocket parents (portaltest)`, **Select**.

**D. Turn sign-up off.** You cannot do this in the admin center; Microsoft documents it as a Microsoft
Graph call. With sign-up on, a stranger could create a parent account.

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

**E. Fill `.env.poc`** on linuxdev. The discovery URL uses the tenant *name* (subdomain) and the tenant
*ID*:
```
PARENT_OIDC_DISCOVERY_URL=https://<tenant-name>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration
PARENT_OIDC_CLIENT_ID=<application (client) ID from B3>
PARENT_OIDC_CLIENT_SECRET=<secret value from B4>
```
Check the URL in a browser first: it must show a block of JSON that includes `issuer`. The app takes the
issuer from that document, so whichever of the Microsoft-documented host forms (tenant name or tenant ID
as the first label of `ciamlogin.com`) returns the JSON works.

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

Do both parts in the Cloudflare dashboard for the account that owns `rhinoautomator.com`.

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

**B. Put Cloudflare Access in front**

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
   `docker ps --filter name=booster-rocket-app` shows `(healthy)`.
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
6. After the first successful deploy, do section 5 step 4 (the seed).

## 8. The test checklist

Run these in order, in a private browser window. Record each outcome in section 10.

- [ ] 1. Visit https://portaltest.rhinoautomator.com: Cloudflare Access asks for an email code; after it, the portal's sign-in page.
- [ ] 2. Staff: sign in at `/staff/sign-in` with Microsoft -> staff home, as Admin.
- [ ] 3. Set the club name and color -> they show on every page.
- [ ] 4. Parent: sign in at `/sign-in` as the seeded test parent -> parent home (not the refusal page).
- [ ] 5. Audit log shows: `admin.bootstrap`, `staff.bind`, staff `signin`, parent `signin`, `parent.object_id_set`, `guardian.activate`, `settings.club.save`.
- [ ] 6. Sign out at both doors -> both `signout` entries appear.
- [ ] 7. The second External ID user (no guardian row) -> refusal page; audit shows `signin.refused` with reason `no_guardian`.
- [ ] 8. `deploy.sh` run a second time with no changes completes and keeps the app healthy; `--rollback` returns to the previous image and the app stays healthy.

**Reading the audit log:** sign in as staff at `/staff/sign-in` and choose **Audit** in the top menu (it
shows only to people who hold the audit-read permission; Admin does). Each row shows time, door
(staff, parent or system), who, the action, and details. A refusal's reason is in the details as
`reason`: each row has a **Details** line you can open, showing the saved before/after values
(for example `{"reason":"no_guardian"}`). Times show in your own device's time zone; the database stores them in UTC (hover a time to see the exact UTC instant; `psql` output follows the server's zone, Central). The person always sees the same
refusal page; the reason is only in the log. If the page itself is unavailable, read the log from the
database on linuxdev:
```bash
cd ~/booster-rocket
docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "select at, door, actor_label, action, after from audit_log order by at desc limit 20;"
```

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Parent sees the refusal page; audit `signin.refused` (door parent), reason `missing_object_id` | The app never saved this parent's Object ID: the token could not be verified (look for a `parent.object_id_unverified` row just before it) | Read the `parent.object_id_unverified` reason below; fix that; sign in again |
| `signin.refused`, reason `no_guardian` | No guardian row has this Object ID | Expected for parent two. For a real tester: copy the Object ID from the external tenant user and run the seed (section 5) |
| `signin.refused`, reason `disabled` | The guardian row exists but its status is disabled | Test data: set it back with `docker compose -f docker-compose.poc.yml --env-file .env.poc exec db psql -U booster -d booster -c "update guardian set status='invited' where email='<email>';"` |
| Staff `signin.refused` (door staff; staff refusals carry no reason, so Details is empty) | The Microsoft account is not a known staff member and is not `BOOTSTRAP_ADMIN_EMAIL` | Sign in with the bootstrap email, or have an Admin add the person first (**Staff** menu) |
| `parent.object_id_unverified`, reason `subject_mismatch` | The ID token's subject differs from the account being signed in | Sign out everywhere, clear cookies, try again; if it repeats, report it (should not happen) |
| `parent.object_id_unverified`, reason `invalid_token:...` (for example `invalid_token:ERR_JWT_CLAIM_VALIDATION_FAILED:iss` or `:aud`, or `ERR_JWT_EXPIRED`) | Wrong issuer or audience, or an expired token. `iss`: discovery URL is for another tenant; `aud`: `PARENT_OIDC_CLIENT_ID` is not the parent app's client ID | Re-check the three `PARENT_OIDC_*` values in `.env.poc`, then restart the app: `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d --force-recreate app` |
| `parent.object_id_unverified`, reason `missing_oid` | The token verified but has no `oid` claim | Check the app registration is in the **external** tenant and sign-in uses its user flow; report the finding (this is the open risk in the spec) |
| `parent.object_id_unverified`, reasons `no_id_token`, `discovery_failed`, `verifier_unavailable`, `user_missing` | No ID token returned; the discovery URL cannot be fetched from linuxdev; or the account row vanished | Open the discovery URL in a browser; check linuxdev has internet access; check admin consent (section 4 B5) |
| `parent.object_id_conflict` in audit | The same account came back with a different Object ID | Test data: use a different external user; report it |
| Microsoft error "AADSTS50011: The redirect URI ... does not match" | Redirect URI in the app registration differs from the one the portal sends | Staff: `https://portaltest.rhinoautomator.com/api/auth/staff/callback/microsoft`; parent: `https://portaltest.rhinoautomator.com/api/auth/parent/callback/parent-oidc`. Platform must be **Web**; no trailing slash |
| App container restarts or will not start; log says "STAFF_ENTRA_TENANT_ID must be the club directory (tenant) GUID" | `.env.poc` has `common`, `organizations`, `consumers` or something that is not a GUID | Put the **Directory (tenant) ID** GUID from the band's tenant Overview page; also set the registration to **Single tenant only** |
| The staff app registration was created as multi-tenant | Wrong **Supported account types** choice | Entra > the app > **Authentication** > **Supported account types** > **Single tenant only** |
| A stranger can create a parent account in External ID | Sign-up left on in the user flow | Redo section 4 D and confirm `isSignUpAllowed` is `false` |
| Browser shows Cloudflare 502 | `cloudflared` cannot reach `booster-rocket-app:3000`: the edge network was not added to cloudflared, cloudflared was not recreated, or the app is unhealthy | `docker network inspect booster-rocket-edge` must list both `cloudflared` and `booster-rocket-app`; if not, redo section 2 steps 3-4. Then `docker ps` for `(healthy)` and `docker logs booster-rocket-app` |
| Form buttons or sign-in fail with a server action or origin/forbidden error | HTTP Host Header is set in the tunnel route, or `APP_URL` is wrong | Clear the HTTP Host Header (section 6 A5); make `APP_URL=https://portaltest.rhinoautomator.com` exactly, then recreate the app |
| Deploy or migrate fails with a database password error after re-running setup | `.env.poc` was deleted and regenerated (new `DB_PASSWORD`) | See the note at the end of section 2 |
| Cloudflare never emails a code | The email is not in the Allow policy, or One-time PIN is not enabled on the application | Section 6 B steps 1-3; check spam |

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
