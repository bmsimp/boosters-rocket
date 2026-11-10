# First-run setup page — Design

**Date:** 2026-11-08
**Status:** Draft for review
**Superseded in part:** Step 2 is now Outgoing mail, not Parent sign-in. See docs/superpowers/specs/2026-11-10-parent-email-code-sign-in-design.md.
**Superseded in part:** Microsoft sign-in uses app-generated certificates, not client secrets. See docs/superpowers/specs/2026-11-09-certificate-credentials-design.md.
**Builds on:** `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md` (v1 spec), Plan 1 (foundation) and
the proof of concept (`docs/superpowers/specs/2026-11-08-poc-linuxdev-design.md`), all on `main`.

---

## 1. What this is

Today a new club pastes its sign-in settings (Microsoft tenant ID, client IDs, client secrets, External ID
discovery address, first Admin email) into an env file on the server. This replaces that with a **setup page
inside the app**. The page walks the admin through creating each app registration, says exactly what to copy
where, checks the values before saving, and stores them encrypted in the database.

Each Microsoft step can optionally be done by a **PowerShell script** that creates the app registration and prints
the values to paste.

### Who it is for

A club volunteer with admin rights in the club's Microsoft tenant, who is comfortable following clicks but is not
a developer.

### Success

A new club goes from `deploy.sh` to working staff and parent sign-in without editing a file or hunting for
values in the Microsoft portals. Staff sign-in is proven working before setup is allowed to finish.

## 2. Decisions already made

| Decision | Choice |
|---|---|
| Automation | **No device code.** Microsoft recommends blocking it and ships a managed Conditional Access policy that does. Optional PowerShell scripts use the normal interactive browser sign-in (`Connect-MgGraph`) instead. |
| Where sign-in values live | **Database only.** The env file no longer holds any sign-in value. |
| Encryption | AES-256-GCM, key in the env file, never in the database. |
| Lock before anyone can sign in | **One-time setup code** issued from the server. |
| How setup finishes | **A real staff sign-in** by the Admin whose email was entered. That person becomes Admin and setup closes. |
| How sign-in picks up new values | **Rebuild in memory** on the next request after a save. No restart. |
| Google | Walk-through only (no script). Expected to be revisited later. |
| Spelling | US English. |
| Times | Stored in UTC, shown in the viewer's local time zone (`LocalTime`). |
| Audit | Every create/update/delete, unlock, refusal, finish and reopen is audited. A missing audit entry is a defect. |

## 3. What the admin sees

### 3.1 The setup page

Until setup is finished, every page except `/api/health`, `/api/auth/*` and `/setup` redirects to **`/setup`**.

1. **Unlock.** "Set up Booster Rocket. Enter the setup code from your server." (See §5.2 for where the code comes from.)
2. **Step 1: Staff sign-in.** Pick Microsoft, Google or both. At least one is required.
   - **Microsoft (band tenant).** Numbered instructions with direct links to the Entra admin center pages. Every
     value the admin types into Microsoft has a copy button:
     - app name `Booster Rocket (staff)`;
     - supported account types: **single tenant**;
     - redirect URI (Web): `<APP_URL>/api/auth/staff/callback/microsoft`;
     - a client secret, 24 months.

     The admin pastes back: **tenant ID** (must be a GUID; `common`, `organizations` and `consumers` are refused,
     as today), **client ID**, **client secret** and the secret's **expiry date** (optional; the script fills it).
     A "Use the PowerShell script instead" panel offers the download (§6).
   - **Google.** Numbered instructions for the Google Cloud console with copy buttons (redirect URI
     `<APP_URL>/api/auth/staff/callback/google`). The admin pastes back the client ID and client secret.
   - **Save** runs the checks in §5.4. On failure the step shows a specific message and saves nothing.
3. **Step 2: Parent sign-in (optional; "Do this later" skips it).** Instructions for the Entra External ID tenant:
   - the app registration, with redirect URI `<APP_URL>/api/auth/parent/callback/parent-oidc`;
   - admin consent for `openid`, `profile`, `email` and `offline_access`;
   - a user flow with **email one-time passcode** sign-in and **sign-up turned off**;
   - adding the app to that user flow.

   The admin pastes back the **tenant subdomain** (the first part of the tenant's `.onmicrosoft.com` domain),
   **tenant ID**, **client ID**, **client secret** and expiry. The app builds the discovery address itself
   (`https://<tenant-subdomain>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration`, the form
   Microsoft documents), so there is no long URL to mistype. The script option does every item above. A **Test parent sign-in** button opens the parent sign-in in
   a new tab. Any result is fine, including a refusal page, because no guardians exist yet; the page shows
   whether Microsoft sent the user back.
4. **Step 3: First Admin.** Enter an email, then **Sign in** with a staff provider saved in Step 1. When the
   signed-in email matches, that person becomes Admin, setup is marked finished, and they land on the staff home.
   If the sign-in fails or the email doesn't match, setup stays open and the page says why.

Progress is saved after each step, so closing the browser and unlocking again resumes where the admin left off.

### 3.2 After setup

- **Staff Settings → Sign-in** shows the same three forms. It needs the permission `settings.signin.manage`, which
  only Admin has by default. Non-secret values are shown and editable. A secret is never shown again; the page
  says "Client secret saved Nov 8, 2026, expires Nov 8, 2028". Entering a new secret replaces the old one.
- **Expiry warning.** From 30 days before a stored secret expires, the staff home shows Admins a banner naming the
  sign-in and the date.
- Removing the last working staff provider is refused: "This would leave no way for staff to sign in."

### 3.3 Locked out

If nobody can sign in (for example, an expired secret), the server owner runs **`scripts/poc/reopen-setup.sh`**. It
marks setup unfinished, prints a fresh setup code and audits `setup.reopen`. The stored values stay, so the admin
only fixes what is broken, then finishes with Step 3 again. Existing Admins remain Admins.

## 4. What changes in the code

### 4.1 Environment

- **Removed:** `BOOTSTRAP_ADMIN_EMAIL`, `STAFF_ENTRA_TENANT_ID`, `STAFF_ENTRA_CLIENT_ID`, `STAFF_ENTRA_CLIENT_SECRET`,
  `STAFF_GOOGLE_CLIENT_ID`, `STAFF_GOOGLE_CLIENT_SECRET`, `PARENT_OIDC_DISCOVERY_URL`, `PARENT_OIDC_CLIENT_ID`,
  `PARENT_OIDC_CLIENT_SECRET`, and the `staffEntraEnabled` / `staffGoogleEnabled` / `parentDoorEnabled` exports.
- **Added:** `SETTINGS_ENCRYPTION_KEY` (required; 32 random bytes, base64) and `SETTINGS_ENCRYPTION_KEY_PREVIOUS`
  (optional, for replacing the key).
- **Kept:** `DATABASE_URL`, `APP_URL`, `BETTER_AUTH_SECRET`.
- `scripts/poc/setup.sh` generates `SETTINGS_ENCRYPTION_KEY`. `.env.poc.example` and `.env.example` are updated.
  Nothing is deployed yet, so no data migration is needed.

### 4.2 Data

New table **`auth_provider`**:

| Column | Notes |
|---|---|
| `key` | primary key: `staff-microsoft`, `staff-google`, `parent-oidc` |
| `config` | jsonb, non-secret values only (tenant ID, tenant subdomain, client ID) |
| `secret_ciphertext` | text: base64 of nonce + ciphertext + auth tag |
| `secret_key_id` | text: first 8 hex characters of SHA-256 of the key that encrypted it |
| `secret_expires_at` | timestamptz, nullable |
| `secret_updated_at` | timestamptz |
| `updated_at`, `updated_by` | `updated_by` is a staff user id, or null for the setup page |

Setup state lives in the existing `setting` table:

- `setup.state`: `{ status: "open" | "finished", step, adminEmail, finishedAt }`
- `setup.code`: `{ hash, issuedAt, failedTotal }`

The code is hashed with SHA-256 plus a per-code salt. It has enough entropy that a slow hash adds nothing.

### 4.3 Encryption (`src/lib/crypto/secret-box.ts`)

- `seal(plaintext, aad)` and `open(ciphertext, keyId, aad)`. AES-256-GCM through Node's `crypto`, with a random
  12-byte nonce per value.
- The additional authenticated data is the row key (`staff-microsoft`, …). A ciphertext copied into another row
  fails to decrypt.
- `open` tries the current key, then the previous key by key ID. A wrong key or a tampered value throws, and the
  caller treats that provider as not configured and logs a server error. It never falls back to an empty secret.
- Decrypted secrets exist only in memory, inside the built sign-in setup. They never reach the browser, the audit
  log or a server log.

### 4.4 Sign-in rebuild (`src/lib/auth/staff-auth.ts`, `parent-auth.ts`)

- `staffAuth` and `parentAuth` constants become `getStaffAuth()` and `getParentAuth()`. Each builds the Better Auth
  instance from the current `auth_provider` rows and caches it with a config version (the rows' latest
  `updated_at`).
- Saving a provider bumps the version in memory. The next call rebuilds. One container runs one process, so an
  in-memory version is enough; the reopen script does not change provider rows.
- The route handlers `src/app/api/auth/{staff,parent}/[...all]/route.ts` and every server-side caller (`resolve.ts`,
  `identity.ts`, `parent-object-id.ts`, `signin-audit.ts`) call the getters. The client-side `client.ts` is
  unchanged.
- With no rows yet, the instances build with no providers, as the env-driven code does today when values are
  missing.

### 4.5 First Admin (`src/lib/auth/bootstrap.ts`)

`claimBootstrapAdmin` reads the wanted email from `setup.state.adminEmail`, not the env, and only while setup is
open at Step 3. The existing advisory lock and "no active Admin yet" rule stay. One addition: when setup was
**reopened** and an Admin already exists, a matching sign-in finishes setup without creating a second Admin.
Claiming the Admin and marking setup finished happen in one transaction.

### 4.6 Redirect to setup (`src/proxy.ts`, new)

A Next.js proxy reads the setup status through a small server route, cached for 5 seconds so a reopen takes effect
quickly. While the status is `open`, every path except `/setup`, `/api/setup/*`, `/api/health`, `/api/auth/*` and
static assets redirects to `/setup`. While it is `finished`, `/setup` returns 404.

## 5. Security

### 5.1 Threats

The setup page is the most powerful page in the app before anyone can sign in: whoever completes it picks the
sign-in providers and the Admin. Everything below exists to keep a stranger who can reach the site from doing that.

### 5.2 Setup code

- **`scripts/poc/setup-code.sh`** runs `node tools/scripts/setup-code.mjs` inside the app container. While setup
  is open, it issues a fresh code (replacing any earlier one) and prints it. Once setup is finished, it refuses.
- **`deploy.sh`** calls it after a healthy deploy whenever setup is open, so the first deploy prints the code.
- **`reopen-setup.sh`** sets the status to open, then issues a code.
- **Codes never go to the container log.** Logs are kept longer and protected less than a terminal.
- **Format:** 12 characters from an unambiguous alphabet (no 0/O/1/I/L), shown as `K7QM-2XPA-9RTE` (about 60
  bits). Entry ignores case, spaces and dashes.
- **Slow-down:** 5 wrong tries per 15 minutes per client address (`cf-connecting-ip`). After 20 wrong tries in
  total, the code is void and the page says to issue a new one on the server. The total sits in `setup.code`, so
  restarting the app does not reset it.
- **Unlocking** sets an httpOnly, Secure, SameSite=Lax cookie `br_setup`. It is Lax, not Strict, because Step 3
  comes back from Microsoft through a cross-site redirect chain that drops Strict cookies. Lax still keeps the cookie
  off cross-site POSTs. It is signed with `BETTER_AUTH_SECRET`,
  bound to the code's hash and valid for 2 hours. Issuing a new code or finishing setup invalidates it.
- Every setup action is a server action or POST that checks the cookie. Next.js's built-in origin check on server
  actions covers cross-site requests.

### 5.3 Secrets on the page

Secret fields are write-only. The server never sends a stored secret, or any part of one, back to the browser.
Saved values show only "saved on <date>, expires <date>".

### 5.4 Checks before saving

- **Staff Microsoft:** a client-credentials token request to
  `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` (scope `https://graph.microsoft.com/.default`).
  Success proves the tenant, client and secret together.
  - `AADSTS7000215` (invalid secret) shows: "Microsoft rejected the secret. If you just created it, wait a few
    minutes and try again — new secrets can take up to 15 minutes to start working."
  - `AADSTS700016` (unknown app) and `AADSTS90002` (unknown tenant) get their own messages.
- **Parent:**
  1. Fetch the built discovery address and check that its `issuer` contains the tenant ID.
  2. Make a client-credentials request to its `token_endpoint`.
- **Google:** format only (client ID ends in `.apps.googleusercontent.com`; secret not empty). Proven in Step 3 if
  Google is the provider used.
- Requests have a 10-second timeout. A network failure says "Couldn't reach Microsoft" and does not blame the
  values.

### 5.5 Audit

| Action | When | Details |
|---|---|---|
| `setup.unlock` | correct code | client address |
| `setup.unlock.refused` | wrong code, slowed down, or void | reason, client address |
| `setup.provider.save` | provider saved (setup page or Settings) | before/after of non-secret values; `secretChanged: true/false`, never the secret |
| `setup.provider.remove` | provider removed in Settings | key |
| `setup.code.issue` | code issued by the server script | none (door system) |
| `setup.finish` | Step 3 succeeds | Admin email |
| `setup.reopen` | reopen script | none (door system) |

The existing `admin.bootstrap`, `staff.bind` and `signin` entries still appear on the first Admin's sign-in.

## 6. PowerShell scripts

- **Files:** `scripts/setup/New-BoosterRocketStaffApp.ps1` and `scripts/setup/New-BoosterRocketParentApp.ps1`.
  The setup page offers them as downloads, with `-AppUrl` filled in and the tenant left for the admin to choose.
- **Requirements:** PowerShell 7 and the `Microsoft.Graph.Authentication` module. If it's missing, the script
  prints the one install command and stops.
- **Sign-in:**
  - staff: `Connect-MgGraph -TenantId <tenant> -Scopes Application.ReadWrite.All, DelegatedPermissionGrant.ReadWrite.All`
    (the second grants admin consent for the sign-in scopes, so staff never see a consent prompt);
  - parent: adds `EventListener.ReadWrite.All`.

  Both use the interactive browser sign-in. Device code is never used.
- **Staff script:**
  1. Find the app named `Booster Rocket (staff)` or create it, single tenant.
  2. Set the Web redirect URI.
  3. Request the delegated Graph scopes `openid profile email offline_access User.Read`.
  4. Create its service principal if missing and grant admin consent for those scopes.
  5. Add a 24-month secret.
  6. Print the tenant ID, client ID, secret and expiry.
- **Parent script:**
  1. The same app steps, with the parent name and redirect URI.
  2. Grant admin consent for `openid profile email offline_access`.
  3. Find the user flow `Booster Rocket parents` or create it: email one-time passcode (`EmailOtpSignup-OAUTH`),
     `isSignUpAllowed: false`.
  4. Add the app to the flow.
  5. Print the values.
- **Safe to run again:** a second run reuses what exists, fixes a wrong redirect URI or sign-up setting, and adds
  a new secret, leaving old secrets alone. It says so, so the admin can delete old secrets later.
- **Writes nothing to disk.** It prints the secret once, with a reminder to paste it now. The script holds no
  tokens after it ends (`Disconnect-MgGraph`).

## 7. Testing

- **Unit:**
  - `secret-box`: round trip; tampered ciphertext fails; wrong row key fails; wrong key fails; the previous key
    decrypts; an unknown key ID fails.
  - Setup code: generation alphabet and format; normalized entry; hash check; slow-down; 20-try void; cookie
    expiry and invalidation.
  - Save checks: Microsoft and External ID responses faked (success, `AADSTS7000215`, `AADSTS700016`,
    `AADSTS90002`, timeout, bad discovery issuer).
  - Env schema: the new key is required; the removed variables are gone.
- **Integration (real Postgres):**
  - The full setup flow through server actions: unlock, save staff, skip parent, Admin claim, finish.
  - Reopen with an existing Admin: no second Admin.
  - The sign-in rebuild after a save.
  - No secret text appears in `audit_log` or the rendered page HTML.
  - Removing the last staff provider is refused.
  - Every action in §5.5 writes its audit row.
- **Playwright:** a fresh database redirects to `/setup`; `/setup` returns 404 after finishing; a wrong code shows
  the refusal; the unlock cookie works.
- **Scripts:** PSScriptAnalyzer runs on `scripts/setup/*.ps1` in CI (no errors), and shellcheck runs on the new
  shell scripts. The real Graph calls are proven in the proof-of-concept run.

## 8. Docs

- `docs/runbooks/poc-linuxdev.md`: the staff app registration and External ID sections become "open the site,
  enter the code `deploy.sh` printed, follow the setup page". The External ID **tenant** itself is still created
  by hand in Azure, because no script creates tenants. The troubleshooting section gains the setup messages and
  `reopen-setup.sh`.
- The proof-of-concept checklist step "Staff: sign in" becomes "Finish setup at `/setup`". `admin.bootstrap` still
  appears in the audit log.

## 9. Not in this work

Creating the External ID tenant automatically, Google automation, certificate credentials instead of secrets,
automatic secret rotation, and multiple Admin emails during setup.

## 10. Risks

- **Microsoft portal changes** can make the walk-through's clicks wrong. Mitigation: links point at stable pages,
  the script path doesn't depend on clicks, and the save checks catch wrong values whatever caused them.
- **New-secret delay.** A brand-new secret can fail for up to about 15 minutes. Mitigation: a specific message
  saying to wait.
- **A lost encryption key** makes the stored secrets unreadable. Mitigation: the reopen path lets the admin
  re-enter them. The runbook says to back up the env file with the database.
- **Graph user-flow API in the parent script** hasn't been run against a real External ID tenant. Mitigation: the
  proof-of-concept run exercises it, and the walk-through covers the same steps by hand.
