# Certificate credentials for Microsoft sign-in — Design

**Date:** 2026-11-09
**Status:** Built by plan `2026-11-09-certificate-credentials.md`, and proved against the band's tenant on the proof of concept on 2026-11-09 (its runbook, check 2).
**Superseded in part:** only staff sign-in uses a certificate now; the parent certificate and its script are removed. See docs/superpowers/specs/2026-11-10-parent-email-code-sign-in-design.md.
**Builds on:** `docs/superpowers/specs/2026-11-08-first-run-setup-design.md` (setup page), on `main`.

---

## 1. What this is and why

The proof-of-concept run hit a real tenant rule: the band's Entra tenant blocks client secrets on apps
(Microsoft's "Block password addition" app policy, error `CredentialTypeNotAllowedAsPerAppPolicy`). More
organizations turn this on every year, and certificates are the more secure credential anyway.

This change makes **both Microsoft sign-ins** (staff, in the club's Entra tenant, and parents, in the
External ID tenant) **use certificates only**. Google staff sign-in keeps its client secret (Google offers no
certificate option).

The app generates the certificate itself. The private key never leaves the server; the admin only uploads
the public certificate to the app registration (by hand or with the PowerShell script). Nothing secret is
copied or pasted for Microsoft at all.

## 2. Decisions

| Decision | Choice |
|---|---|
| Microsoft credential | **Certificate only.** No client secret option for `staff-microsoft` or `parent-oidc`. |
| Google credential | Client secret, unchanged. |
| Who makes the key | The app, on the server: RSA 2048 key and a self-signed X.509 certificate, valid 2 years (`notBefore` is backdated 5 minutes for clock skew; `notAfter` is exactly 730 days after creation). |
| Private key storage | Encrypted with the existing secret box (AES-256-GCM, `SETTINGS_ENCRYPTION_KEY`), AAD bound to the certificate row. Never sent to the browser, logged, or audited. |
| Client authentication | `private_key_jwt` (RFC 7523): a signed assertion per token request, header `alg PS256`, `typ JWT`, `x5t#S256` = base64url SHA-256 thumbprint of the certificate DER, and `x5t` = base64url SHA-1 thumbprint (derived from the stored hex `thumbprint_sha1`); claims `aud` = the token endpoint, `iss` = `sub` = client ID, `jti` random UUID, `nbf`/`iat` now, `exp` now + 5 minutes. (Per Microsoft's certificate-credentials reference.) |
| Library | `@peculiar/x509` (MIT) for certificate generation; `jose` (already a dependency) for signing. Better Auth already supports assertions: `clientAssertion` on the `microsoft` social provider, `tokenEndpointAuth: { method: "private_key_jwt", getClientAssertion }` on generic OAuth. |
| Expiry | Taken from the certificate (`notAfter`), never typed in. The existing 30-day warning uses it. |
| Spelling, times, audit | US English; times stored UTC; every create/change/delete audited. |

## 3. What the admin sees

### 3.1 Setup page, Microsoft sign-in (staff Step 1 and parents Step 2)

Each Microsoft card works the same way:

1. **Download the certificate.** A button "Download certificate (.cer)". The first click creates the key pair
   and certificate for that sign-in (state **pending**) and downloads the public certificate as
   `booster-rocket-staff.cer` / `booster-rocket-parents.cer`. Later clicks download the same pending
   certificate; nothing new is made. The page shows its thumbprint and expiry date.
2. **Put it on the app registration**, one of:
   - **By hand:** the walk-through's last step becomes "**Certificates & secrets** → **Certificates** →
     **Upload certificate**, choose the `.cer` file, **Add**". The client secret step is removed.
   - **Script:** the downloaded PowerShell script has the certificate built in and uploads it (§5).
3. **Enter the tenant ID and client ID** (parents: also the tenant subdomain) and **Check and save**. The
   check signs an assertion with the pending key and requests a token (§4.3). On success the certificate
   becomes **active** and the sign-in is saved. On failure nothing changes and the message says what to do.

The form no longer has a client secret field or an expiry field for Microsoft. The Google card is unchanged.

### 3.2 Settings → Sign-in, after setup

Each Microsoft card shows the active certificate's thumbprint and expiry. **Replace certificate** creates a
new pending certificate (download it, upload it, then **Check and switch**). Until the switch succeeds, the
old certificate keeps signing in. On switch, the old certificate's private key is deleted. A note says the
admin can then remove the old certificate from the app registration in Entra.

### 3.3 Script download note

The setup page and Settings tell Windows users to run `Unblock-File .\<script>.ps1` before running a
downloaded script (Windows blocks unsigned downloaded scripts; found in the PoC run).

## 4. What changes in the code

### 4.1 Data

New table **`provider_certificate`**:

| Column | Notes |
|---|---|
| `id` | uuid primary key |
| `provider_key` | `staff-microsoft` or `parent-oidc` |
| `status` | `pending`, `active` or `retired` |
| `certificate_pem` | public certificate (PEM) |
| `thumbprint_s256` | base64url SHA-256 of the DER (for the `x5t#S256` header) |
| `thumbprint_sha1` | hex SHA-1 (what the Entra admin center displays, for matching by eye) |
| `not_after` | timestamptz, from the certificate |
| `private_key_ciphertext`, `private_key_key_id` | sealed PKCS#8 PEM; AAD = `certificate:<id>`; both set to null when retired |
| `created_at`, `created_by` | `created_by` is a staff user id, or null from the setup page |
| `activated_at`, `retired_at` | timestamptz, nullable |

At most one `pending` and one `active` row per provider key (partial unique indexes).

`auth_provider`: `secret_ciphertext` and `secret_key_id` become nullable (null for Microsoft rows);
`secret_expires_at` stays for Google. Microsoft rows' expiry comes from their active certificate.

### 4.2 Loading and sign-in

- `loadProviders()` returns, for each Microsoft provider, `{ config, assertion: { privateKeyPem, thumbprintS256 } , expiresAt }`
  from its **active** certificate, in place of `secret`. A provider row with no active certificate, or one whose
  key can't be decrypted, is treated as not set up (logged, as today).
- New `src/lib/auth/client-assertion.ts`: `createEntraAssertionGetter({ clientId, privateKeyPem, thumbprintS256 })`
  returns a Better Auth `ClientAssertionGetter` that signs the §2 assertion for whatever token endpoint Better
  Auth passes in.
- Staff: the `microsoft` social provider gets `clientAssertion` and no `clientSecret`.
- Parents: generic OAuth gets `tokenEndpointAuth: { method: "private_key_jwt", getClientAssertion }` and no
  `clientSecret`.
- The provider version bump on activate/switch rebuilds sign-in, as today.

### 4.3 Checks before saving

`checkMicrosoft` and `checkParent` take the pending (or, when only IDs changed, the active) certificate and
make the client-credentials request with `client_assertion` and
`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` instead of `client_secret`.
Kept: 10-second timeout, `redirect: "error"`, parent token endpoint pinned to https `*.ciamlogin.com`.
New messages:

- `AADSTS700027` (assertion signature invalid / certificate not on the app): "Microsoft doesn't have this
  certificate on the app yet. Upload it (or run the script), wait a minute, and try again."
- `AADSTS700024` (assertion outside its valid time): "The server's clock looks wrong, so Microsoft refused the
  certificate. Check the server's time."
- `AADSTS700016`, `AADSTS90002`, `AADSTS900023` keep their existing messages. `AADSTS7000215`/`7000222`
  (secret) messages are removed.
- A refused Microsoft save is audited `setup.provider.save.refused` (target `auth_provider/<key>`, actor,
  permission, IP) with `after: { reason, certificateThumbprintSha1 }`: `check_failed` when the check fails,
  `certificate_changed` when the certificate it was checked with changed before the save took the lock.
  Never key material.

### 4.4 Certificate lifecycle (`src/lib/auth/certificates.ts`)

- `getOrCreatePendingCertificate(providerKey, actor, ip)`: returns the pending row, creating it (key pair,
  self-signed certificate with subject `CN=Boosters Rocket <staff|parents> (<APP_URL host>)`, 2-year validity)
  if none exists. Audited `certificate.create` (provider key, thumbprints, not-after; never key material).
- `activatePendingCertificate(providerKey, actor, ip, tx)`: inside the provider save transaction, marks the
  pending row active and the previous active row retired (private key nulled). Audited
  `certificate.activate` and, for the old row, `certificate.retire`.
- Removing a Microsoft provider retires its certificates (keys nulled), audited.
- `startCertificateReplacement(providerKey, actor, ip)`: **Replace certificate**. Under the same lock, keeps a
  pending row whose key this server can decrypt (pressing Replace twice changes nothing), retires a pending
  row it can't decrypt (`certificate.retire`), and otherwise creates a new pending row even while one is
  active (`certificate.create`).
- `discardPendingCertificate(providerKey, actor, ip)`: **Discard replacement**. Retires the pending row and
  nulls its key. Audited `certificate.discard`.
- Replace and discard are POST server actions, never a side effect of a download. Both the setup page
  (`setupAction`, so they also work after `reopen-setup.sh`, for example when the old key can't be
  decrypted) and Settings → Sign-in (`staffAction("Settings.SignIn.ReadWrite")`) offer them.
- Certificate download: one route, `/setup/certificates/<file>.cer`, for both a setup session and an Admin
  with `Settings.SignIn.ReadWrite`. It serves the pending certificate if one exists, else the active one,
  else creates a pending one, as `application/pkix-cert` (DER). Public data, but still gated like the
  scripts.

### 4.5 PowerShell scripts

- The download route embeds the certificate to upload (pending, else active) into the script as
  `$CertificateBase64 = '<base64 DER>'`, the same way it fills `-AppUrl`. A script downloaded with no
  certificate yet creates one first (the route calls `getOrCreatePendingCertificate`).
- Both scripts stop creating secrets. Instead, after the app, service principal and consent steps:
  1. Read the app's `keyCredentials` (`GET applications/{id}?$select=keyCredentials`).
  2. If no entry has this certificate's thumbprint, PATCH `keyCredentials` with the existing entries plus
     `{ type: "AsymmetricX509Cert", usage: "Verify", key: <base64 DER>, displayName: "Boosters Rocket <date>" }`.
     Existing certificates are kept.
  3. Print only the tenant ID, client ID (parents: tenant subdomain too), and the certificate's SHA-1
     thumbprint and expiry so the admin can match it in Entra.
- Kept: interactive `Connect-MgGraph` (never device code), `-ContextScope Process`, `Disconnect-MgGraph` in
  `finally`, safe to re-run (re-running with the same certificate changes nothing).
- `Application.ReadWrite.All` already covers PATCH `keyCredentials`. No secret is printed anywhere.

## 5. Security

- The private key exists only on the server, encrypted at rest; the browser and scripts only ever see the
  public certificate.
- Assertions live 5 minutes and carry a unique `jti`.
- A stolen database without `SETTINGS_ENCRYPTION_KEY` yields no usable key.
- Audit rows record thumbprints and dates only.

## 6. Testing

- **Unit:** certificate generation (valid X.509, RSA 2048, 2-year `notAfter`, both thumbprints computed
  correctly against `node:crypto` `X509Certificate`); assertion getter (header `PS256`/`JWT`/`x5t#S256`,
  claims, 5-minute `exp`, signature verifies with the certificate's public key using `jose`); check messages
  for `AADSTS700027`, `700024`, and that the request body carries `client_assertion` and never
  `client_secret`.
- **Integration (real Postgres):** pending → active → retired lifecycle (one pending/one active, retired key
  nulled, audit rows, no key material in audit); save with a pending certificate activates it; failed check
  leaves it pending; `loadProviders` exposes the active certificate only; sign-in rebuild after a switch;
  removing a provider retires its certificates; certificate and script download routes (gating, DER body,
  embedded base64 matches the pending certificate).
- **Scripts:** the vitest text checks updated (no `addPassword`, `keyCredentials` PATCH present,
  `$CertificateBase64` token present once); PSScriptAnalyzer clean.
- **e2e:** the Microsoft card has no secret field and offers the certificate download; downloading twice
  yields the same certificate.
- **PoC:** re-run the staff script against the band tenant (it reuses the `Booster Rocket (staff)` app it
  already created), then finish setup.

## 7. Docs

Runbook: the Microsoft steps upload a certificate instead of creating a secret; add `Unblock-File`; the
troubleshooting rows for secrets become rows for `AADSTS700027`/`700024`. The first-run setup spec gets a
note that Microsoft sign-in uses certificates (this spec supersedes its secret steps for Microsoft).

## 8. Not in this work

Automatic certificate rotation, certificates from a club's own CA, uploading a club-made certificate or key,
Google changes, removing old certificates from Entra automatically.

## 9. Risks

- **Entra propagation delay** after uploading: a fresh certificate can take a minute or two to work. The
  `AADSTS700027` message says to wait and retry.
- **PATCH `keyCredentials` needs the full collection.** The script reads the existing entries (with their
  `key` values via `$select`) and sends them back; if Graph withholds a `key`, the script refuses rather than
  dropping an existing certificate, and says to upload by hand.
- **Server clock.** Assertions depend on the server time; `AADSTS700024` is reported plainly.
