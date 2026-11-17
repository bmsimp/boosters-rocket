# Documenso Community Edition: hands-on verification for Booster Rocket forms

**Date:** 2026-11-14 to 2026-11-15 (three agent sessions; the second was cut off by a machine reboot)
**Spec checked against:** `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md`, sections 3, 9, 14 and 15
**Status:** Done. Forms were built on it (the roadmap's steps 4 and 5), and `deploy/compose.yml` runs the version it tested. Its section 9, the checks only the owner can do, is in docs/runbooks/before-the-first-family.md, part 4.
**Tested:** Documenso v2.22.0, image `documenso/documenso@sha256:f9976d2142d34ee89506e161b0a5ec859a0c327f3fe0a398b46d3941fc8dd35e`
(Docker Hub tags `v2.22.0` and `latest` on 2026-11-14; git commit `d32d0491`; released 2026-11-13), unmodified, no licence key.

File paths below (scripts, evidence, `NOTES.md`) are relative to the spike folder, which was kept on the build machine outside this
repository and is not part of it. The local Documenso the tests ran against is the Docker compose project `br-documenso-spike`.
An independent check followed; its corrections are section 1a and win where they differ from the rest.

## 1. Verdict

Booster Rocket can build commitment forms on Documenso Community Edition as section 9 describes: an unmodified image, the v2
API, webhooks and embedded signing, with Documenso sending no mail about documents. Everything the portal needs is in the AGPL
edition and none of it is gated on a self-hosted instance. Embedded signing worked in a cross-site frame with no cookies in
Chromium, WebKit and iPhone-emulated WebKit. DocuSeal is not needed as a fallback.

Section 9 does have to change (section 5 of this report). The changes that alter the design, not just the wording:

1. Leaving a template role out does **not** drop it. A one-guardian document from a two-role template needs an extra call that
   deletes the unused recipient, or the document can never complete.
2. Webhooks cannot be trusted to arrive. Four attempts inside a third of a second, then nothing. The portal must also poll.
3. "The guardian signed" and "the document is sealed" are separate moments. Sealing is a background job. With a timestamp
   authority configured, an outage there leaves signed documents unsealed until a sweep succeeds, or for good after six hours.
4. A sent document cannot be edited (signer or names). To change either, delete it and create a new one.
5. Hosting has two requirements nobody had written down: the reverse proxy must hand Documenso the bare client IP in
   `X-Forwarded-For` (it drives both the IP in the audit record and a hard 100-requests-a-minute limit that signing runs under),
   and Documenso's sign-up page is open to the world until it is closed with environment variables.

## 1a. Corrections from the independent check

A second engineer re-ran the claims the design leans on hardest against the same running instance. Thirteen were confirmed,
six were overstated and two could not be checked here. Where this section and the rest of the report disagree, this section
wins.

**Overstated in the report**

1. *"Without the delete step a one-guardian document can never complete."* It stays pending until the unused recipient is
   removed. Removal after sending works only while that recipient has not signed and has no inserted field, followed by a
   second `distribute`. A prefilled text field counts as inserted, so with the portal's own templates the delete must come
   before sending, as the recipe says.
2. *"A sent document cannot be edited."* A recipient is locked only once they have signed or one of their fields is inserted.
   The portal prefills every guardian's name, so every guardian is locked at send: delete-and-recreate holds for the portal,
   but as a consequence of prefilling.
3. *"After six hours nothing retries sealing."* Documenso's own sweep stops after six hours, but the portal can queue sealing
   again with `POST /envelope/distribute` on a pending envelope whose recipients have all signed. The sweep also covers any
   failed seal, so "signed, waiting for the sealed copy" is a state with or without a timestamp authority.
4. *"The certificate is the last page of the sealed PDF and the audit log is separate."* That is the default. Two team
   settings decide what is appended (`includeSigningCertificate`, `includeAuditLog`). The portal must not assume the layout.
5. *"The rate limits cannot be changed."* They cannot be tuned, but `DANGEROUS_BYPASS_RATE_LIMITS=true` switches every limiter
   off, sign-in limits included. It exists for upstream's tests and is not a fix; the proxy header is.
6. *"Find a lost envelope with `GET /envelope?query=<externalId>`"* and *"`lockName` locks the name."* `query` is a
   case-insensitive substring search over title, externalId and recipient name or email, with `_` and `%` as wildcards: the
   portal must filter the hits for an exact externalId. `lockName` is applied in the browser from the URL fragment, and `name`
   is ignored when the recipient already has one: neither is a control.

**Could not be checked here:** sign-in against a real Microsoft Entra tenant, and the backup-and-restore run (its evidence
files are consistent, but it was not repeated).

**What the report missed**

- **Prefilled fields must be read-only, and the portal must check it.** A prefilled text field that is not read-only can be
  changed by the signer with the token alone (shown: a student's name replaced). When staff attach a template, the portal
  refuses any field it will prefill whose `fieldMeta.readOnly` is not true.
- **Signing works only under the exact origin in `NEXT_PUBLIC_WEBAPP_URL`.** Every write the signing frame makes is refused
  with 403 unless the browser's Origin header equals it. Reached under any other name, scheme or port, the form loads and
  cannot be signed, with no message to the portal. The frame address and the health check use that one configured name.
- **Rejection is a state.** A recipient can reject (the direct signing page shows the button; the embed hides it unless asked).
  The envelope becomes `REJECTED` with `completedAt` set, and `DOCUMENT_REJECTED` fires. The portal needs a state for it and a
  way forward (delete and recreate).
- **The API token and the organisation hang on one Documenso user.** Deleting the account that made the token deletes the
  token; a disabled owner makes every API call fail and blocks the embed. The token, webhook and organisation belong to an
  account that is not a person who may leave.
- **An email flag the portal does not send is stored as true.** If a later Documenso adds a tenth flag, documents from an
  unchanged portal would have it on. The mail test belongs on the upgrade checklist, with the version pinned.
- **The signer's IP may be unfixable by configuration on some hosts.** Documenso reads only the first `X-Forwarded-For` entry
  and does not fall back when it is unusable (for example `ip:port`). Either a small proxy the club controls sits in front, or
  the certificate says "Unknown" and the portal's consent record is the IP of record.
- **Documenso compresses nothing.** A first load of the signing frame was 184 requests and 7.2 MB. Compression has to come
  from the proxy in front, or the first open on mobile data is slow.
- **The certificate page prints "Authentication Level: Email"** although Documenso emailed nobody and checked nothing. The
  link between a signature and the signed-in guardian exists only in the portal's records. Show this to the club's lawyer,
  with the option of putting the audit log inside the signed PDF.
- **Two guardians who share one email address are fine:** one document, two recipients, two tokens.

## 2. Results at a glance

| # | Question | Verdict | One line |
|---|---|---|---|
| S1 | Stack, image, certificate | Pass | Compose project `br-documenso-spike`; self-signed `.p12` made the documented way |
| S2 | Account and API token | Pass | Done without a browser, but through the web UI's internal endpoints: there is no public API for it |
| a | v2 API, template with two signer roles | Pass | `POST /api/v2/envelope/create` with `type: "TEMPLATE"`; header `Authorization: api_...` |
| b | One recipient from a two-role template | Partial | Works only with `use` -> `recipient/delete` -> `distribute`; otherwise a phantom signer blocks completion |
| c | Emails off | Pass | Per-document override, both `distributionMethod: "NONE"` and all nine flags false: 0 mails from creation to completion |
| d | Embedded signing, cross-origin, no cookies | Pass | Chromium 158, WebKit 27.2, iPhone 15 emulation; the recipient token is the only credential |
| d' | Real Safari on a real iPhone | Not testable here | Owner check |
| e | Licensing | Pass | Nothing the portal needs is licensed; plan gates apply only when billing is switched on |
| f | Staff sign-in through OIDC | Pass (mock provider) | In the AGPL code, no licence check; Entra needs `NEXT_PRIVATE_OIDC_SKIP_VERIFY=true` |
| f' | A real Entra tenant | Not testable here | Owner check |
| g | Webhooks | Partial | Real payloads captured; plain shared secret, no signature, no event id, no real retry |
| h | Evidence download, hash, signature | Pass | Sealed PDF, certificate PDF, audit log PDF and JSON by API; signature valid; issuer untrusted (self-signed) |
| h' | Timestamp | Partial | None by default; works with a TSA configured; a TSA outage delays or blocks sealing |
| h'' | IP in the audit record | Partial | Only when the proxy sends a bare IP; the header is trusted blindly |
| i | Create on first open | Pass | Median 451 ms (two guardians, one call) and 585 ms (one guardian, three calls); token usable at once |
| j | Memory, storage, backup, restore | Pass | 440-470 MiB idle, up to 880 MiB after a burst; PDFs in the database; restore proven |
| j' | Upgrade | Partial | Migrations run on every start (seen); a version-to-version upgrade was not run |
| k | Conflicts with the spec's assumptions | Partial | The four assumptions hold, each with a condition (section 4.k) |

## 3. Set-up

### 3.1 What runs

`docker-compose.yml` (project `br-documenso-spike`), secrets in `.env` (local throwaways):

| Service | Address | What |
|---|---|---|
| `documenso` | http://localhost:3500 | The upstream image pinned by digest |
| `database` | 127.0.0.1:5434 | postgres:16, database `documenso`, named volume |
| `mailpit` | http://localhost:8526 | Mail catcher (UI and REST API); SMTP only inside the compose network |
| `webhook-listener` | http://localhost:3700 | `scripts/webhook-listener.mjs`, writes each delivery to `evidence/webhooks/` |
| `embed-host` | http://127.0.0.1:3600 | `embed-host/index.html`, the stand-in for the portal page that frames Documenso |
| `mock-oidc` | http://localhost:8527 | `scripts/mock-oidc.mjs`, a stand-in identity provider (not a real one) |

The official instructions are `apps/docs/content/docs/self-hosting/deployment/docker-compose.mdx` in the Documenso repository
(https://docs.documenso.com, "Self-hosting"), which point at `docker/production/compose.yml` and the image `documenso/documenso`.
The source at the tested tag is in `upstream/documenso` (read only; nothing from it was executed).

Certificate, as `self-hosting/configuration/signing-certificate/local.mdx` describes:
`openssl genrsa` -> `openssl req -new -x509 -days 365` -> `openssl pkcs12 -export` with a password. Result `cert/cert.p12`,
mounted read-only at `/opt/documenso/cert.p12`; details in `cert/cert-info.txt`. A `.p12` without a password makes signing fail.

Start-up: the container runs `sh start.sh`, which checks the certificate, runs `npx prisma migrate deploy` (169 migrations on the
first start, 0 pending on later ones) and starts the server. Health: `GET /api/health` -> database ok, certificate ok.

### 3.2 Account and API token, and what a volunteer does by hand

`scripts/01-setup-account.mjs` did it with plain HTTP: sign up, read the confirmation mail from the mail catcher, verify, sign
in, find the team, create an API token, create the webhook. Those calls are the web UI's own (`/api/auth/...`, `/api/trpc/...`).
**None of this is in the documented v2 API.** In production a volunteer does these by hand, once:

1. Open `https://sign.<club domain>/signup`, create the first account, click the link in the confirmation email (so Documenso's
   SMTP must already work).
2. Create an organisation for the club and a team in it, so that other staff can be invited to it.
3. Team settings -> API Tokens -> create a token (no expiry) -> paste it into the portal's settings.
4. Team settings -> Webhooks -> add the portal's URL, a secret, and the events -> paste the secret into the portal's settings.
5. Optional, needs one SQL statement: make that account an instance admin (`ADMIN` added to `"User".roles`; there is no UI for the
   first one) and in Admin -> Organisations tick "Hide Documenso branding" and "White label for embed signing".
6. Close sign-up (section 7) and invite the other staff to the organisation.

Recorded in `account.json` (email, password, team id, API token, webhook id, template ids). Treat it as a secrets file.

## 4. Answers

### a. Is there a v2 API, how is it authenticated, can a template be made through it? Pass

- Base `https://<host>/api/v2`, 89 operations; OpenAPI document saved from the running instance: `evidence/api/openapi-v2.json`
  (`node scripts/oas.mjs POST /envelope/use` prints one operation).
- Authentication: header `Authorization: <api token>` (the token starts `api_`; a `Bearer ` prefix is not needed). A token
  belongs to one team.
- The current model is the *envelope*: one or more PDFs, recipients, fields. Documents and templates are both envelopes
  (`type: "DOCUMENT"` or `"TEMPLATE"`). The older `/document/*` and `/template/*` operations still exist; use `/envelope/*`.
- Template created through the API: `scripts/02-create-template.mjs` -> `POST /api/v2/envelope/create`, multipart with a
  `payload` JSON part (`type: "TEMPLATE"`, recipients, fields, meta) and a `files` part (the PDF). 200 in 1.6 s.
  Two SIGNER recipients with placeholder addresses; per guardian a read-only TEXT field for the name, a SIGNATURE and a DATE
  field; one read-only TEXT field for the student name. Evidence `evidence/api/template-main-*.json`.
- Staff can equally author the template in Documenso's editor, as the spec says. That path was not driven here. What the portal
  needs from any template is the same: recipient ids and the ids of the text fields to prefill, read with
  `GET /api/v2/envelope/{templateId}`. Fields carry `fieldMeta.label`, which is the natural way to find "Student name".

### b. One recipient from a two-role template. Partial

`scripts/03-create-document.mjs`, state in `documents.json`, evidence `evidence/api/document-*.json`.

- Prefill works: `prefillFields: [{id: <template field id>, type: "text", value}]`; the field comes back `inserted: true`.
- **Not mentioning the second role does not remove it.** The document gets a second recipient with the template's placeholder
  address, its own signing token and its three fields. The first guardian signed, the frame said `document-completed`, and the
  envelope stayed `PENDING` for good (`one-plain`, `evidence/embed/one-plain-r0-chromium-block3p.json`).
- What works: create without distributing, `POST /api/v2/envelope/recipient/delete {recipientId}` for the unused recipient
  (its fields go with it), then `POST /api/v2/envelope/distribute`. One guardian signs, the document completes (`one-deleted`).
- Both guardians: one call, `POST /api/v2/envelope/use` with `distributeDocument: true`; the response carries each recipient's
  `token` and `signingUrl`. Signing order is parallel by default: on `order-check` the second guardian signed first.
- A recipient on a sent document cannot be changed: `POST /api/v2/envelope/recipient/update-many` -> 400 "Cannot modify a
  recipient who has already interacted with the document", even before the guardian opens it, because the prefilled fields
  count as theirs (`evidence/api/recipient-swap-on-pending.json`).
- The printed text of the PDF is not touched: a one-guardian document made from a two-guardian form still shows the empty
  "Guardian 2" lines (`evidence/screenshots/whitelabel-before-flags.png`). If that looks wrong, the club needs a one-guardian
  and a two-guardian version of the form.

### c. Emails off. Pass

Counted in the mail catcher (`evidence/mail/*.json`):

| Document | Settings sent with `POST /envelope/use` | Mails, creation to completion |
|---|---|---|
| `one-deleted`, `two-plain`, `one-plain` | none (template already has NONE and all flags false) | 0 |
| `mail-on` (control, two signers) | `distributionMethod: EMAIL`, all flags true | 8 |
| `ovr-off` (template has Documenso's defaults) | `distributionMethod: NONE`, all flags false | 0 |
| `ovr-none-only` | `distributionMethod: NONE`, flags true | 1 ("Signing Complete!" with the PDF, to the owner account) |
| `ovr-settings-only` | `distributionMethod: EMAIL`, flags false | 0 |

- So the portal sends, on every creation, `override: {distributionMethod: "NONE", emailSettings: {…all nine false}}`, whatever
  the staff-authored template says. The nine: `recipientSigningRequest`, `recipientRemoved`, `recipientSigned`,
  `documentPending`, `documentCompleted`, `documentDeleted`, `ownerDocumentCompleted`, `ownerRecipientExpired`,
  `ownerDocumentCreated`. A document can be sent for signing this way: status `PENDING`, tokens issued, no mail.
- On completion with those settings: no mail to anyone.
- The organisation flag "Disable emails" (admin panel) is **not** a full kill switch in v2.22.0: with it on and document emails
  on, the signing requests and completion mails stopped but two "X has signed" mails still went to the owner
  (`evidence/mail/disable-emails-flag-test.json`). Do not rely on it.
- Account mail is separate and still needed: sign-up confirmation, password reset, organisation invitations. Documenso needs
  working SMTP even though it sends nothing about documents.

### d. Embedded signing. Pass (real devices: owner check)

- How to embed: an iframe at `https://<documenso>/embed/sign/<recipient token>#<options>`, where options is
  `base64(encodeURIComponent(JSON.stringify({...})))` and never reaches the server. Documented in
  `developers/embedding/iframe.mdx` (which calls the raw iframe "not recommended" and prefers the SDKs).
- SDK packages (npm, MIT, 0.8.0): `@documenso/embed-react` and the same for vue, svelte, angular, solid, preact, webcomponent.
  Component `EmbedSignDocument` with props `token`, `host` (required for a self-hosted instance), `name`, `lockName`, `css`,
  `cssVars`, `darkModeDisabled`, `clientUserId`, `onDocumentReady`, `onDocumentCompleted`, `onDocumentError`. The SDK builds the
  same iframe URL and listens for the same messages. **The SDK itself was not run**; the spike used the iframe directly
  (`embed-host/index.html`), which needs no new dependency.
- The token: the per-recipient signing token. It is returned by `POST /envelope/use` (when distributing), by
  `POST /envelope/distribute`, and again by `GET /envelope/{id}`.
- Test page on `http://127.0.0.1:3600`, Documenso on `http://localhost:3500`: different host and port, so cross-origin and
  cross-site. `scripts/05-sign-embedded.mjs` signed inside the frame with Playwright 1.65:

  | Browser | Document | Result |
  |---|---|---|
  | Chromium 158 | `one-deleted` | signed, document COMPLETED |
  | Chromium 158, third-party cookies blocked, drawn signature | `one-plain` | signed |
  | WebKit 27.2 desktop | `two-plain`, guardian 1 | signed |
  | WebKit 27.2, iPhone 15 emulation | `two-plain`, guardian 2 | signed, document COMPLETED |
  | WebKit 27.2, iPhone 15 emulation | `order-check`, guardian 2 signing first | signed |

  Evidence `evidence/embed/*.json`, screenshots `evidence/screenshots/*`.
- Cookies: no `Cookie` header on any request to Documenso; the only `Set-Cookie` is `lang` on the frame document and the browser
  did not keep it; `document.hasStorageAccess()` was false in WebKit. The token in the URL is the only credential. In production
  `portal.` and `sign.` share a registrable domain, which is an easier case than the one tested.
- Messages the frame posts to its parent (`targetOrigin` `*`, `event.origin` is Documenso's origin):
  `{action: "document-ready", data: null}`, `{action: "field-signed", data: {fieldId, value, isBase64}}`,
  `{action: "document-completed", data: {token, documentId, recipientId, envelopeId}}`. The source also has `document-error`,
  `document-rejected` and `field-unsigned` (`apps/remix/app/components/embed/embed-document-signing-page-v2.tsx`); they were not
  seen. `document-completed` means *this recipient finished*, not that the envelope is complete.
- A failure the frame does not report: when its API calls were rate-limited (429) the form simply did not take the signature
  and no `document-error` was posted (`evidence/embed/rate-limited-signer-chromium.json`).
- Framing: Documenso answers `/embed/*` with `Content-Security-Policy: ... frame-ancestors *` and no `X-Frame-Options`
  (`apps/remix/server/security-headers.ts`). Nothing to configure, and it cannot be narrowed to the portal's origin. On the
  portal side the page's CSP must allow `frame-src https://sign.<club domain>`, and the message handler must check
  `event.origin` and `event.source`.
- What the signer does: desktop: signature pad in the side bar (type or draw) -> click the signature field -> Complete -> confirm.
  Phone width: tap the field -> dialog (draw or type) -> Sign -> Complete. Date fields fill themselves.
- Options worth using: `name` + `lockName: true`, `darkModeDisabled: true`, `allowDownloadPDF: false` (hides the button only).

### e. Licensing. Pass

Read: `LICENSE` (AGPL-3.0), `packages/ee/LICENSE` (Documenso Commercial License), `packages/ee/FEATURES`,
`apps/docs/content/docs/policies/{community-edition,enterprise-edition}.mdx`, `self-hosting/configuration/license.mdx`,
`packages/lib/types/subscription.ts`, `packages/lib/server-only/license/*.ts`, `packages/ee/server-only/limits/server.ts`,
`apps/remix/app/routes/embed+/_v0+/sign.$token.tsx`.

| Feature the portal uses | Community Edition, no key | Where it says so |
|---|---|---|
| Signing, templates, recipient roles | Yes | Documenso's edition table (`enterprise-edition.mdx`) |
| v2 API and webhooks | Yes | same table |
| Embedded signing | Yes | same table; in code the paywall is `IS_BILLING_ENABLED() && !flags.embedSigning`, and billing is off |
| Unlimited documents, recipients | Yes | `SELFHOSTED_PLAN_LIMITS` = Infinity when billing is off |
| Instance-wide OIDC sign-in | Yes | `packages/auth` (AGPL), no licence check |
| Self-signed or CA certificate, timestamp authority | Yes | same table; `packages/signing` |
| Custom CSS in the embedded page, hiding "Powered by Documenso" | Yes, after an instance admin ticks two flags | flags `embedSigningWhiteLabel`, `hidePoweredBy` are not enterprise flags; proved live |
| Organisations, teams, member invitations | Yes | counts are checked only when billing is on |

Licensed only (`packages/ee`, need `NEXT_PRIVATE_DOCUMENSO_LICENSE_KEY`): Stripe billing, the per-organisation Authentication
Portal (SSO), re-authentication before signing (passkey or 2FA), 21 CFR, email domains, embedded *authoring* and its white
label, CSC signing. The portal uses none.

Hosted-product gates and whether they bite here: Documenso's docs say embedding needs the Teams plan and custom CSS the Platform
plan. Those are cloud plans. On a self-hosted instance `NEXT_PUBLIC_FEATURE_BILLING_ENABLED` is unset, so the plan check is
skipped. Live proof, no key (`scripts/12-admin-flags.mjs`, `evidence/licensing/admin-flags.json`): the admin panel says
"No License Configured"; the organisation's claim was `free` with no flags and embedded signing worked throughout; the admin
panel lets an admin tick `hidePoweredBy`, `embedSigning`, `embedSigningWhiteLabel`, `disableEmails` and four others, and greys
out the seven enterprise flags. Before the two flags: `css`/`cssVars` ignored and the badge shown. After: applied and hidden
(`evidence/screenshots/whitelabel-{before,after}-flags.png`).

AGPL: the club runs the image unmodified and Booster Rocket talks to it over HTTP, so there is nothing to publish.
Without a key Documenso does not contact the licence server (`license-client.ts` returns before the request).

### f. Staff sign-in through OIDC. Pass against a mock provider; a real tenant is an owner check

- Available in the Community Edition with no key. Environment variables: `NEXT_PRIVATE_OIDC_WELL_KNOWN`,
  `NEXT_PRIVATE_OIDC_CLIENT_ID`, `NEXT_PRIVATE_OIDC_CLIENT_SECRET`, `NEXT_PRIVATE_OIDC_PROVIDER_LABEL`,
  `NEXT_PRIVATE_OIDC_SKIP_VERIFY`, `NEXT_PRIVATE_OIDC_PROMPT`. Redirect URI: `https://sign.<club domain>/api/auth/callback/oidc`.
  Scopes `openid email profile`, authorization code with PKCE.
- For Entra: well-known `https://login.microsoftonline.com/<tenant id>/v2.0/.well-known/openid-configuration`, a single-tenant
  app registration, and **`NEXT_PRIVATE_OIDC_SKIP_VERIFY=true`**: Documenso refuses an ID token without `email_verified: true`,
  and Entra does not send that claim. Each staff account in Entra needs a mail address and a display name.
- Tested with `scripts/mock-oidc.mjs` and `scripts/10-oidc-signin.mjs` (`evidence/oidc/*.json`): a verified user signs in; an
  Entra-like user (no `email_verified`) is refused with skip-verify off and signs in with it on; a user with no email is
  refused; a user whose email equals an existing password account is signed in **as that account** (linked by email, no further
  check); a user outside the allowed domain is refused.
- Signing in is not the same as seeing the club's templates. A new user gets a personal organisation only. The owner invites
  them to the club's organisation (Documenso emails the invitation) and they accept. Done here end to end without a licence
  (`scripts/16-staff-onboarding.mjs`, `evidence/oidc/staff-onboarding.json`); the invited user's view of the team was not
  checked in a browser.
- Sign-up is open by default. Tested: `NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS=<domain>` with
  `NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP=true` refuses password sign-up (400 `SIGNUP_DISABLED`) and OIDC users from other
  domains, and lets club-domain OIDC users in.
- Not tested: Entra itself (consent, exact claims, conditional access, guests).

### g. Webhooks. Partial

- Configured per team in the UI (Team settings -> Webhooks); there is no v2 API operation for it.
- Real payloads: `evidence/webhooks/NNNN-hook-<EVENT>.json` (first series), `r2-NNNN-...` (after the reboot), then `0219` on.
  They contain recipient signing tokens.
- Events in one document's life: `DOCUMENT_CREATED` and `TEMPLATE_USED` (either order), `DOCUMENT_SENT`, `DOCUMENT_OPENED`
  (first open per recipient), `DOCUMENT_RECIPIENT_COMPLETED` then `DOCUMENT_SIGNED` (both per recipient, same payload),
  `DOCUMENT_COMPLETED` (once, after sealing, 1-7 s later). Also `DOCUMENT_CANCELLED`, which fires for a cancel, for the delete
  of a pending document (payload status still `PENDING`) and for the delete of a completed one (status `COMPLETED`, `deletedAt`
  set). Other events exist: `DOCUMENT_REJECTED`, `DOCUMENT_REMINDER_SENT`, `RECIPIENT_EXPIRED`, `TEMPLATE_*`.
- Body: `{event, payload, createdAt, webhookEndpoint}`; `payload` is the document: `id` (number), `envelopeId`, `externalId`,
  `status`, `completedAt`, `deletedAt`, `templateId`, `teamId`, `documentMeta`, `recipients[]` (each with `id`, `email`, `name`,
  `token`, `signingStatus`, `signedAt`, `readStatus`, `sendStatus`, `expiresAt`). No event id, no delivery id, and nothing that
  says which recipient caused it.
- Authentication: header `X-Documenso-Secret` carrying the secret as typed into the webhook form. A plain shared secret: no
  HMAC, no signature over the body, no timestamp.
- Retry (`scripts/08-webhook-retry.mjs`, `evidence/webhooks-analysis/retry-probe.json`): a receiver answering 500 got four
  attempts within 0.3 s, then the delivery is failed for good. Nothing more in 90 s. Ten-second timeout per attempt; a redirect
  counts as a failure. A resend exists only as a button in Documenso's UI.
- Repeats: one delivery per event normally; repeats only through those immediate retries.
- Documenso refuses webhook URLs that resolve to private addresses unless the host is listed in
  `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS`. Needed if the portal is reached by an internal name.

### h. Evidence. Pass, with two conditions

`scripts/06-download-evidence.mjs <document>` -> `evidence/pdf/<document>/` with a `manifest.json` (sizes, SHA-256, timings).

- `GET /api/v2/envelope/item/{envelopeItemId}/download?version=signed` -> the sealed PDF. `version=original` -> the uploaded PDF.
- `GET /api/v2/envelope/{id}/certificate/download` -> the signing certificate as its own one-page PDF.
- `GET /api/v2/envelope/{id}/audit-log/download` -> the audit log as a PDF; `GET /api/v2/envelope/{id}/audit-log` -> as JSON.
- The certificate is **both**: the last page of the sealed PDF and a separate download. The audit log is separate only.
  The separate certificate and audit PDFs are rendered on request and are not digitally signed.
- SHA-256 of the sealed PDF of `two-plain`: `b2a4362966fa0b2f4fee60233e7c47595028b1f12e032567721adc846a8e2ee4`. The sealed PDF
  is stored, so the hash is the same on every download (and after a restore).
- Signature (pdfsig 25.04 from poppler in a container, and `openssl cms -verify`): `Signature is Valid`, `Total document
  signed`, type `ETSI.CAdES.detached`, SHA-256; `Certificate issuer isn't Trusted`. That last line is what any reader shows for
  a self-signed certificate: a valid, unmodified signature from an identity the reader does not know. Documenso's docs say the
  same and point to Adobe's trust list for a certificate that shows green.
- Timestamp: **none by default**; the signing time is the server's clock. With
  `NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY=http://timestamp.digicert.com` the sealed PDF gains an RFC 3161 token in the
  signature, LTV data and a document timestamp (DigiCert responder, chain to DigiCert Trusted Root G4;
  `evidence/pdf/tsa-doc/cms-summary.txt`). pdfsig cannot check the document timestamp; Adobe Reader can (owner check).
- Audit record (JSON): `createdAt`, `type`, `name`, `email`, `userAgent`, `ipAddress`, `data`. Types seen: `DOCUMENT_CREATED`
  (with the template id), `RECIPIENT_DELETED`, `DOCUMENT_SENT`, `DOCUMENT_FIELDS_AUTO_INSERTED`, `DOCUMENT_VIEWED`,
  `DOCUMENT_OPENED`, `DOCUMENT_FIELD_INSERTED`, `DOCUMENT_RECIPIENT_COMPLETED`, `DOCUMENT_COMPLETED`. The certificate page shows
  per signer: name, email, role, signature image and id, IP address, device, sent/viewed/signed times in UTC.
- IP address: Documenso takes the first entry of `X-Forwarded-For` and keeps it only if it is a bare IP.

  | Header the proxy sent | Recorded |
  |---|---|
  | none | null, "Unknown" on the certificate |
  | `203.0.113.7` | 203.0.113.7 |
  | `203.0.113.9:51234` | null, "Unknown" |
  | `198.51.100.200, 203.0.113.9` (client-supplied value first) | 198.51.100.200 |

  Evidence `evidence/pdf/{tsa-doc,ip-port,ip-chain}/`. There is no trusted-proxy setting.

#### The timestamp outage test

`tsa-down`: with the TSA URL pointed at a name that does not resolve, the guardian signed at 06:17:25 UTC. The recipient became
`SIGNED`, `DOCUMENT_RECIPIENT_COMPLETED` and `DOCUMENT_SIGNED` arrived, the seal job failed (`TimestampError`, three retries in
2.3 s, no fall-back to an untimestamped signature) and the envelope stayed `PENDING`
(`evidence/ops/tsa-unreachable-seal-failure-log.txt`). The TSA was put back at 06:19. Documenso re-queues sealing every
15 minutes for documents whose last signature is between 15 minutes and 6 hours old: the 06:30 sweep skipped it (too recent),
the 06:45 sweep sealed it. `COMPLETED` at 06:45:12 UTC, 27 min 47 s after the signature, with the `DOCUMENT_COMPLETED` webhook
and a timestamped PDF (`evidence/ops/tsa-outage-recovery-by-sweep.json`, `evidence/pdf/tsa-down/`). After six hours nothing retries.

### i. Create on first open. Pass

`scripts/09-latency.mjs 15` (`evidence/api/latency.json`), on a machine shared with another test run:

| Recipe | Calls | Median | p95 |
|---|---|---|---|
| Two guardians | 1 (`use` with `distributeDocument: true`) | 451 ms | 986 ms |
| One guardian of a two-role template | 3 (`use`, `recipient/delete`, `distribute`) | 585 ms | 1577 ms |
| Frame document for a token made milliseconds earlier | `GET /embed/sign/<token>` | 186 ms | 290 ms |
| Delete an unsigned pending document | `POST /envelope/delete` | 231 ms | 404 ms |

Five creations at once took 1.3 s. In a browser the frame posts `document-ready` about a second after navigation in Chromium.
Recipient links expire after three months by default; `override.envelopeExpirationPeriod: {disabled: true}` is accepted.

### j. Operations. Pass (upgrade: partial)

- Memory (`docker stats`, `evidence/ops/docker-stats-*.txt`): 437-468 MiB idle after a start; 540-660 MiB while two people sign
  and the documents are sealed; 881 MiB after 35 creations in 30 seconds, and it stays there. CPU: one core busy for 2-4 seconds
  per signing. Documenso's Postgres: 45-80 MiB. Image: 2.23 GB. Documenso's own figure for production is 2 cores and 2 GB.
- Storage: by default every PDF is in the database (`DocumentData`, base64). 16 MB after about 50 files; a sealed one-page form
  is 230-310 KB. Alternatives are `s3` and `azure-blob` (`NEXT_PUBLIC_UPLOAD_TRANSPORT`); there is no migration between them.
- Upgrade: pull the new image and restart; migrations run on start and are forward only (a rollback is a restore). The docs
  say to pin a version tag. Not done here: an actual move from one version to the next.
- Backup and restore, done (`evidence/ops/backup/`): `pg_dump -F c` (0.5 s, 1.7 MB) -> `pg_restore` into a second database on
  the same server -> a second Documenso from the same image. `scripts/14-restore-check.mjs`: the old API token works, the sealed
  PDF is byte-identical, the audit log is there, password sign-in works, a new document can be made from the template. All of
  that still passed with a **new** `NEXTAUTH_SECRET` and **new** encryption keys.
- So, to back up: the database (it holds the documents, audit logs, templates, accounts, token hashes and the webhook
  configuration); the signing certificate `.p12` and its passphrase; the env file for convenience. The encryption keys protect
  only two-factor secrets and per-organisation mail settings; `NEXTAUTH_SECRET` only signs session cookies.
- Database role: a plain role that owns its database is enough. All 169 migrations ran as a non-superuser, including
  `CREATE EXTENSION pgcrypto` and `pg_trgm` (`evidence/ops/non-superuser-role-migrations.txt`).
- Background work (sealing, webhook delivery, mail) runs inside the one container, queued in a Postgres table, driven by HTTP
  calls Documenso makes to itself (`NEXT_PRIVATE_INTERNAL_WEBAPP_URL`). No Redis. The docs rate this for small deployments.
- Rate limits, hard-coded per client IP: `/api/v2/*` 1000 a minute, `/api/trpc/*` 100 a minute. Embedded signing uses
  `/api/trpc/*`, four requests per signer. "Client IP" is the first entry of `X-Forwarded-For`. With no header everyone shares
  one bucket: request 101 in a minute was refused (`scripts/11-trpc-rate-limit.mjs`, `evidence/ops/trpc-rate-limit.json`).

### k. Conflicts with the spec's assumptions

| Assumption | Holds? | Condition |
|---|---|---|
| One Postgres server holds `portal` and `documenso` | Yes | Own database and role for Documenso; Postgres 14+; extensions `pgcrypto` and `pg_trgm` (on Azure Flexible Server they must be allow-listed first: not testable here); about 8-10 connections |
| Documenso's emails are off | Yes, for document mail | Only by sending the override with every document. Account mail (confirmation, reset, invitations) still needs SMTP |
| Unmodified upstream image | Yes | Configuration is environment variables plus a mounted or base64 certificate. Two things need a hand: the first instance admin (SQL) and the one-time UI steps of section 3.2 |
| v2 API, webhooks and embed only | Yes, for everything about documents | Account, API token and webhook cannot be created through the API |

Other things the spec does not expect: templates have no version; a sent document cannot be edited; sealing is asynchronous;
sign-up is open by default; telemetry is on unless `DOCUMENSO_DISABLE_TELEMETRY=true`. See section 5.

## 5. What has to change in the spec

Section 9:

1. **9.1, roles.** Say how the portal reads a template: `GET /envelope/{templateId}`, signer recipients in order = guardian
   roles, TEXT fields found by label (for example "Student name", "Guardian 1 name", "Guardian 2 name"). Add a check when staff
   attach a template to a form, with a plain message when a label or role is missing. Record that a one-guardian document from
   a two-guardian form keeps the printed "Guardian 2" lines, so a club may want two versions of a form.
2. **9.1, "any one guardian or every guardian".** Decide the rule for "any one": the document is made for the guardian who opens
   it; if the other guardian opens it while it is unsigned, the portal deletes it and makes a new one, because a sent document's
   signer cannot be changed. "Every guardian" is limited to the number of roles in the template (two).
3. **9.2 step 3.** Replace "creates one from the template with ... the required guardians as recipients" with the recipe in
   section 6: one call when every role is filled; three calls (create, delete the unused recipient, distribute) otherwise.
   Always send `externalId`, the email override, the club's time zone and date format, and the expiry setting.
4. **9.2 step 3, "names always current".** True only until the document exists. Add: if a name or guardian changes while a
   document is unsigned, delete and recreate it; if someone has already signed, staff decide (cancel and start again, or keep).
5. **9.2 step 4.** Name the mechanism: an iframe (or `@documenso/embed-react`, a new dependency) at
   `/embed/sign/<token>` with `name`, `lockName`. The token can be fetched from the API at each open; it need not be stored.
   The frame's `document-completed` message only means this guardian finished; use it to refresh the page, never to record
   completion. Note that the same token also works at `sign.<domain>/sign/<token>` outside the portal, so the consent step is
   enforced by the portal only handing out the token after consent.
6. **9.2 step 5.** Replace with: the webhook carries a shared secret in `X-Documenso-Secret` (compare in constant time); it has
   no event id and is not retried in any useful way; on any event the portal fetches the envelope and stores what it finds;
   a scheduled job polls every document that is not finished (`GET /envelope/{id}` or `POST /envelope/get-many`). Completion is
   `status === "COMPLETED"`, not `completedAt` and not the event name.
7. **9.2 between steps 5 and 6.** Add the state "signed, waiting for the sealed copy", shown to the parent in words, and an
   alert to staff when it lasts more than an hour.
8. **9.2 step 6.** "Downloads the signed PDF and the audit certificate" becomes: the sealed PDF (the certificate is its last
   page), the audit log as JSON and as PDF, and optionally the certificate PDF. Hash the sealed PDF.
9. **9.2, last line.** "Documenso's own emails are turned off" becomes "the portal turns them off for each document it creates;
   Documenso still sends account mail to staff".
10. **9.3.** The staff matrix needs the states "not opened yet" (no document exists), "waiting for the other guardian" and
    "signed, being sealed".
11. **9.4.** "The template version": Documenso has none. Keep the template's envelope id and `updatedAt`, and the SHA-256 of the
    original PDF, which Documenso keeps with every document. Add: the IP on Documenso's certificate is only as good as the
    proxy header; the portal's consent record is the IP of record. Add the timestamp decision (item 12).

Other sections:

12. **Section 3 / 14, new decision: timestamps.** Either no timestamp authority (signing time is the server's clock, nothing
    outside is needed) or one or more TSA URLs (trusted time; sealing then depends on an outside service, and a hash of each
    document is sent to it). Section 15 asked for "validates with timestamp", which needs the second.
13. **Section 3, hosting.** The proxy in front of Documenso must set `X-Forwarded-For` to the bare client IP. Plan about 1 GB
    of memory for Documenso. Sign-up must be closed.
14. **Section 9.1 / 14, runbook.** Staff sign-in: generic OIDC with skip-verify on; staff are invited to the club's
    organisation after their first sign-in; the first admin needs one SQL statement.
15. **Section 14, backups.** Add the signing certificate and its passphrase. The health page can check Documenso with
    `GET /api/health` and one authenticated API call; it cannot ask Documenso whether the webhook is configured, so it should
    show when the last webhook arrived.
16. **Section 15.** Mark the Documenso row done, with the owner checks of section 9 of this report still open.

## 6. The API recipe, as verified

All calls: `Authorization: <api token>`, base `https://sign.<club domain>/api/v2`.

**When staff attach a template to a form**

`GET /envelope/{templateEnvelopeId}` -> `recipients[]` (`id`, `role`, `signingOrder`), `fields[]` (`id`, `type`, `recipientId`,
`fieldMeta.label`), `updatedAt`, `envelopeItems[]`.

**When a guardian opens a form and no document exists (after consent)**

Every role filled, one call:

```
POST /envelope/use            (multipart/form-data, one part named "payload" holding JSON)
{
  "envelopeId": "<template envelope id>",
  "externalId": "<the portal's signature_request id>",
  "distributeDocument": true,
  "recipients": [ {"id": <template recipient id>, "email": "...", "name": "..."}, ... ],
  "prefillFields": [ {"id": <template field id>, "type": "text", "value": "..."}, ... ],
  "override": {
    "title": "...",
    "distributionMethod": "NONE",
    "emailSettings": { all nine flags: false },
    "timezone": "America/Chicago", "dateFormat": "MM/dd/yyyy",
    "envelopeExpirationPeriod": {"disabled": true}
  }
}
-> 200 {"id": "envelope_...", "recipients": [ {"id", "name", "email", "token", "role", "signingOrder", "signingUrl"} ]}
```

Fewer guardians than roles, three calls:

```
POST /envelope/use              same payload, "distributeDocument": false, only the guardians who will sign
POST /envelope/recipient/delete {"recipientId": <id of each recipient in the response that is not one of ours>}
POST /envelope/distribute       {"envelopeId": "envelope_..."}   -> 200 with recipients and their tokens
```

**Each time a guardian opens the form**

`GET /envelope/{id}` -> `status`, `recipients[]` with `token`, `signingStatus`, `signedAt`. Give the signed-in guardian their
own token only. Frame `https://sign.<club domain>/embed/sign/<token>#<base64(encodeURIComponent(JSON options))>`.
Do not fetch that URL from the server: a plain GET counts as the recipient opening the document.

**On a webhook, and on a schedule for everything unfinished**

`GET /envelope/{id}`, or `POST /envelope/get-many {"ids": {"type": "envelopeId", "ids": [up to 20]}}`.
Lost track of an id: `GET /envelope?type=DOCUMENT&query=<externalId>`.

**When `status` is `COMPLETED`**

```
GET /envelope/{id}                                  -> envelopeItems[].id, completedAt
GET /envelope/item/{envelopeItemId}/download?version=signed     -> sealed PDF (hash it)
GET /envelope/{id}/audit-log?perPage=100&orderByDirection=asc   -> audit entries (JSON)
GET /envelope/{id}/audit-log/download               -> audit log PDF
GET /envelope/{id}/certificate/download             -> certificate PDF (optional; it is also the last page of the sealed PDF)
```

**Withdrawing a document**

Unsigned: `POST /envelope/delete {"envelopeId"}` (then it is gone: 404). Partly signed: `POST /envelope/cancel {"envelopeId",
"reason"}` -> status `CANCELLED`. Never delete a completed one (it is a soft delete, but it drops out of listings).

**Things to code for**

- No idempotency key on `use`. Take a lock on the signature request, store the envelope id as soon as `use` answers, and on
  recovery look the envelope up by `externalId`. A crash between the three calls leaves a `DRAFT` to delete.
- Errors: the HTTP status is right; the body has `code: "INTERNAL_SERVER_ERROR"` and a stack trace even for a 400. Log, do not show.
- 429 with `Retry-After` when the 1000-a-minute limit is hit.

## 7. Hosting notes

- Required environment: `NEXTAUTH_SECRET`, `NEXT_PRIVATE_ENCRYPTION_KEY`, `NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY`,
  `NEXT_PUBLIC_WEBAPP_URL`, `NEXT_PRIVATE_DATABASE_URL` (and `NEXT_PRIVATE_DIRECT_DATABASE_URL`, the same without a pooler),
  `NEXT_PRIVATE_SMTP_*` with `FROM_NAME` and `FROM_ADDRESS`, `NEXT_PRIVATE_SIGNING_PASSPHRASE`, and the certificate as a file at
  `NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH` (default `/opt/documenso/cert.p12`) or as base64 in
  `NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS`. `PORT` defaults to 3000. `NEXT_PRIVATE_INTERNAL_WEBAPP_URL` should be the
  container's own address (`http://localhost:<port>`) so background jobs do not go out through the proxy.
- Recommended: `DOCUMENSO_DISABLE_TELEMETRY=true`; the OIDC variables; `NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS=<club domain>` with
  `NEXT_PUBLIC_DISABLE_EMAIL_PASSWORD_SIGNUP=true` (tested), or `NEXT_PUBLIC_DISABLE_SIGNUP=true` once every staff account
  exists; `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS` if the portal's webhook address is internal; the timestamp decision.
- The certificate: self-signed is enough to seal and to detect tampering; readers will say the signer is not trusted. It
  expires (the one here in a year). Renewing it changes nothing in documents already sealed. Back it up with its passphrase.
- Proxy: replace `X-Forwarded-For` with the bare client IP (no port, no list). This is what the IP on the certificate and the
  per-IP limits depend on.
- Size: 1 GB of memory for Documenso alone, one core most of the time. The image is 2.2 GB, so a first pull is slow.
- Upgrades: pin the version; back up; pull; restart; migrations run by themselves. Read the release notes for major versions.

## 8. Risks

1. **Lost webhooks.** No retry worth the name. Without polling, a portal restart loses completions.
2. **Sealing depends on a timestamp authority if one is set.** An outage longer than six hours leaves signed documents
   unsealed until someone acts. With none set, there is no trusted time in the signature.
3. **The 100-a-minute limit on signing.** With a correct proxy header it is per family address (about 25 signings a minute from
   one Wi-Fi network). With no header it is 25 a minute for the whole club, staff included, and the frame gives no error.
4. **Open sign-up** on a public address until closed.
5. **OIDC links accounts by email** and, for Entra, without a verified-email claim. Whoever can set a mail attribute in the
   tenant can take the Documenso account with that address.
6. **The webhook secret is a static header** and the payload carries every recipient's signing token. Use HTTPS only, keep the
   body out of logs.
7. **A fast-moving upstream.** v2.22.0 was two days old when tested; the envelope API is the newer of two generations. Pin the
   version and re-run this folder's scripts before moving.
8. **Self-signed certificate.** Parents who open the PDF in Adobe Reader see that the signer cannot be verified.
9. **Unverified on real hardware:** Safari on an iPhone, and Entra.
10. **The first instance admin and the branding flags need direct database access.**

## 9. Checks only the owner can do

1. On a real iPhone, in Safari and from the installed home-screen app, open a form in the portal, sign with a finger and
   confirm the page shows it as signed, with "Prevent Cross-Site Tracking" on (the default).
2. On an Android phone in Chrome, do the same.
3. Register a single-tenant app in the club's Entra tenant, set the OIDC variables and skip-verify, and sign in as a staff
   member who has a mailbox and as one who has not. Then invite that member to the club's organisation and confirm they see
   the templates.
4. On the real host, sign one form and read the IP address on the certificate page: it must be the phone's public address.
5. Open a sealed PDF in Adobe Acrobat Reader and read the signature panel, with and without a timestamp authority.
6. On Azure Database for PostgreSQL, allow-list `PGCRYPTO` and `PG_TRGM` and confirm Documenso's first start completes.
7. Decide about timestamps (section 5, item 12).
8. Have the club's lawyer look at one sealed PDF with its certificate page and the audit log.

## 10. Running the stack

From the spike folder, in Git Bash:

```
docker compose --env-file .env -p br-documenso-spike up -d        # start
docker compose --env-file .env -p br-documenso-spike stop         # stop, keep everything
docker compose --env-file .env -p br-documenso-spike logs -f documenso
curl -s http://localhost:3500/api/health
```

Reset to empty, then rebuild the account and templates:

```
docker compose --env-file .env -p br-documenso-spike down -v
mv account.json account.old.json; mv documents.json documents.old.json
docker compose --env-file .env -p br-documenso-spike up -d
node scripts/01-setup-account.mjs
node scripts/02-create-template.mjs main
node scripts/02-create-template.mjs mailon defaults
```

Remove everything, images included:

```
docker compose --env-file .env -p br-documenso-spike --profile restore-test down -v --remove-orphans
docker image rm br-documenso-spike-tools documenso/documenso:v2.22.0
```

- Documenso: http://localhost:3500, account `admin@spike.test`; password, team id and API token are in `account.json`
  (`password`, `teamId`, `apiToken`). Mail: http://localhost:8526. Webhook log: http://localhost:3700/log.
- Useful scripts: `03-create-document.mjs <name> --guardians 1|2 --strategy plain|delete-second|one-call --emails on|off`,
  `05-sign-embedded.mjs <name> <recipient index> chromium|webkit [--iphone] [--draw] [--xff <value>]`,
  `06-download-evidence.mjs <name>`, `13-set-org-flag.mjs <flag> true|false`. Playwright is resolved from the repo's
  `node_modules` by `scripts/pw.mjs`.

### State the stack was left in

- All six containers up; `GET /api/health` ok at 2026-11-15 06:46 UTC.
- Timestamp authority on (`http://timestamp.digicert.com`): each sealing sends a hash there.
- OIDC pointed at the mock provider, skip-verify on. Sign-up restrictions empty (Documenso's default: open).
- `admin@spike.test` has the instance `ADMIN` role. The organisation claim has `hidePoweredBy` and `embedSigningWhiteLabel` on,
  so the badge is hidden and `css`/`cssVars` work in the embed.
- A second organisation "Spike Booster Club" with team "Forms" exists; the templates, token and webhook are still in the
  admin's Personal Team (id 3).
- Documents: 10 completed (plus `ovr-off`, completed then soft-deleted); 4 pending (`retry-probe`, `whitelabel`, `seq-check`
  unsigned; `order-check` with the second guardian signed); `one-plain` cancelled; `two-onecall` deleted.
- Mail catcher holds four messages; it forgets everything when its container restarts.

## 11. Candid notes

- A real iPhone and a real Entra tenant were not available. WebKit under Playwright on Windows is the nearest stand-in for
  Safari, not Safari.
- Templates authored in Documenso's editor, the React embed SDK, S3 or Azure Blob storage, a version-to-version upgrade, Azure
  hosting, signature persistence (`clientUserId`) and sequential signing were not exercised.
- The Azure App Service form of `X-Forwarded-For` (`ip:port`) is widely reported but was not confirmed from Microsoft's
  documentation here; owner check 4 settles it.
- The reboot emptied the mail catcher; the lists saved before it are in `evidence/mail/`.
- The webhook listener restarted its numbering after the reboot and five first-series files were overwritten by later
  deliveries with the same number and event (`0002`, `0005`, `0018`, `0019`, `0020`). Payloads of the same kinds are still on
  disk. The listener now continues its numbering; the later files are named `r2-...`.
- One document was signed while the shared rate-limit bucket was exhausted by a test. It failed, was kept as evidence of what
  a rate-limited signer sees, and was signed again a minute later.
- The spike sent document hashes to DigiCert's public timestamp service and package-name lookups to the npm registry, and
  searched Microsoft's public documentation. No name or address from the project was used anywhere.
- This report was returned to the orchestrator and was **not** saved as `REPORT.md` by the agent that wrote it: the harness it
  ran under refuses to let a sub-agent write a report file, and the agent did not work around that. `NOTES.md` holds every
  verdict and evidence file name.

## 12. Checked on Postgres 18 (2026-11-17)

The installation moved from Postgres 16 to Postgres 18 (`deploy/compose.yml`: `postgres:18.7@sha256:2ea8630d...`, the
official image; `docs/runbooks/updates.md`, "Moving to a new major version of Postgres"). Documenso v2.22.0
(`documenso/documenso:v2.22.0@sha256:f9976d21...`, the image this verification used) was checked on it for real, on a
Windows machine's Docker, by the build that made the move. What was checked:

| Check | How | Result |
|---|---|---|
| Its migrations apply to an empty database on 18 | A first installation from `deploy/compose.yml` on fresh volumes: `initdb/10-databases.sql` made the `documenso` role and database, Documenso started on it | "169 migrations found", each applied; `_prisma_migrations` holds 169 finished rows, none failed or rolled back, the last `20261111000001_lowercase_recipient_emails`; the container healthy, `/api/health` `database ok, certificate ok` |
| It starts on a database restored from a Postgres 16 backup | Documenso's database on 16 (its migrations, its two service accounts, an account signed up through `POST /api/auth/email-password/signup`), backed up by `scripts/backup.sh` with 16's tools, restored with `scripts/restore.sh` into Postgres 18, once by `scripts/move-postgres.sh deploy` and once by hand into a fresh 18 | "No pending migrations to apply"; healthy; `/api/health` ok; every one of its 56 tables held the same number of rows (249 in all) on 18 as on 16 |
| It works on that database | The account made on 16 signed in on 18 (`POST /api/auth/email-password/authorize` 201; `/settings/profile` 200 signed in, 302 to `/signin` without); a second account signed up on 18 (201, its user and organisation rows written) | Reads and writes work. A wrong password answers 500 on 16 and on 18 alike: Documenso's own behaviour, not the move's |
| Its extensions and roles | `pg_extension` on 18 after the move | `pgcrypto`, `pg_trgm`, `plpgsql`; every table owned by `documenso`; neither role may connect to the other's database |
| A document signed, sealed and its evidence downloaded on 18 (checked by the review of the move, 2026-11-17, and not repeated by the fix that followed it) | Documenso v2.22.0 on Postgres 18.7, on a database restored from a Postgres 16 backup by `scripts/backup.sh` and `scripts/restore.sh`, without a browser: `POST /api/v2/envelope/distribute`, then the signing page's own tRPC calls (`envelope.field.sign`, `recipient.completeDocumentWithToken`) as the embedded frame makes them, then the seal, then the four downloads | distribute 200; field signed 200; completed 200 (`SIGNED`), the envelope `COMPLETED` at 2026-11-17T14:48:28Z; the sealed PDF 200 (222499 bytes), the certificate 200 (192713 bytes), the audit log as PDF 200 (267145 bytes) and as JSON 200 (8 entries) |

Not checked on 18: signing in the embedded frame in a browser, and webhook delivery (neither was run against an 18
stack). They use the same database calls as the checks above, but they were not run. The next walk of
`scripts/walk-forms-by-hand-local-documenso.ts` against a Documenso on Postgres 18 closes it; the local Documenso stack
used for this verification still runs Postgres 16.
