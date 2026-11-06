# Booster Rocket v1 — Design

**Date:** 2026-11-06
**Status:** Draft for review
**First deployment:** FZN Band Boosters (`portal.fznband.org`)

---

## 1. What this is

Booster Rocket is an open-source parent portal for booster clubs and other parent groups that
support youth programs. A parent signs in, sees their own students and what their family owes,
pays open invoices, keeps their contact details current, and signs this season's commitment
forms. Volunteers manage the family roster and forms from the same app.

It replaces the WordPress + CiviCRM portal (`band-booster-portal` and `band-booster-portal-ext`).
That stack worked, but its look and feel could not be made acceptable, and it tied the portal to
the club's public WordPress site. Booster Rocket is a standalone app on its own subdomain. The
public site stays where it is.

### Who uses it

| Who | How they sign in | What they do |
|---|---|---|
| **Parent / guardian** | Parent sign-in (Entra External ID, email one-time code) | See their students, balances and open invoices; pay; edit contact details; sign forms |
| **Staff** (board members, volunteers, band directors) | Staff sign-in (Microsoft Entra or Google) | Whatever their roles allow: roster, finance views, forms, settings |
| **Student** | Never signs in | Appears only as a record on their family |

### The constraints that decide the trades

1. **One volunteer maintains a club's copy, with no developer budget.** A successor may not code.
   They must be able to keep it running: updates apply without a developer, there is a tested
   restore, and the runbooks assume no programming. They are not expected to change the code.
2. **QuickBooks Online is the source of truth** for money and for the family roster. The portal
   never holds its own version of either; it reads from QuickBooks and writes changes back
   through it.
3. **It is published as open source (AGPL-3.0).** Every club runs its own copy. There is no
   multi-club hosted service: one club's families never share a database with another's.
4. **One family never sees another family's data, and anonymous visitors see none.** This is
   enforced by test, not by convention (§10).

## 2. Scope

### In v1

- Parent and staff sign-in
- Family roster (families, students, guardians) managed in the portal, stored in QuickBooks
- Family balance, open invoices, and a "Pay" link per invoice to QuickBooks' payment page
- Parent contact-detail edits that write back to QuickBooks
- Seasonal commitment forms signed in Documenso, with completion tracking
- Permissions system for staff
- Audit log
- Setup flow, deployment image, backup/restore and QuickBooks runbooks

### Not in v1

Messaging and announcements, events and calendar, volunteer sign-ups, uniform and instrument
inventory, medical forms, fundraising credit, student logins, limiting a staff role to a subset of
families (for example one section), and payments taken outside QuickBooks. The data model must
not make these hard to add later, but none of them is designed here.

## 3. Architecture

```
                 ┌──────────────── one club's deployment ────────────────┐
 parent browser ─┤  portal (Next.js)  ── Postgres (portal db)            │
 staff browser  ─┤     │   │   │                                         │
                 │     │   │   └── worker (same image, scheduled jobs)   │
                 │     │   └────── Documenso (sign.<domain>) ── Postgres │
                 └─────┼───────────────────────────────────────────────── ┘
                       ├── QuickBooks Online API (read + write)
                       ├── Entra External ID (parent sign-in, Graph provisioning)
                       ├── Entra / Google (staff sign-in)
                       └── Email: SMTP or Microsoft Graph
```

- **Portal:** one Next.js (TypeScript) app. All QuickBooks, Graph and Documenso calls happen on
  the server. The browser never receives a QuickBooks token, a Graph token, a Documenso API key,
  or another family's identifiers.
- **Worker:** the same container image started in worker mode. It runs scheduled jobs (§8.4,
  §6.3) and retries queued writes. Jobs are stored in Postgres, so there is no Redis.
- **Database:** Postgres. One Postgres server holds two databases, `portal` and `documenso`.
- **Documenso:** the upstream Community Edition image, unmodified, at `sign.<club domain>`.
  Booster Rocket talks to it only through its v2 API, webhooks and embed SDK.
- **Packaging:** one Docker image per release, published to GitHub Container Registry, with a
  `stable` tag. Database migrations run on start-up after a pre-migration backup check.
- **FZN hosting:** Azure App Service for Containers (portal, worker, Documenso on one plan) and
  Azure Database for PostgreSQL Flexible Server. Other clubs can run the same images anywhere that
  runs containers and Postgres. Cost estimate and plan size are confirmed during the Documenso
  hands-on test (§13).

Library choices (ORM, sign-in library, UI kit, job queue) are made in the implementation plan,
within these rules: mainstream and actively maintained; no paid licence; supports generic OIDC
providers; and nothing that requires a developer to run a build to change a setting.

## 4. Data model

QuickBooks owns families and students. The portal owns only what QuickBooks cannot hold.

### Owned by QuickBooks

| Concept | QuickBooks entity | Notes |
|---|---|---|
| **Family** | Top-level `Customer` | `DisplayName` must be unique across customers, vendors and employees |
| **Student** | Sub-customer: `Customer` with `ParentRef` = family, `Job = true`, `BillWithParent = true` | Invoices may be raised on the family or the student |
| **Primary contact** | The family customer's `PrimaryEmailAddr`, phones, `BillAddr` | Belongs to the family's primary guardian |
| **Invoices, payments, balances** | `Invoice`, `Payment`, `Customer.Balance`, `BalanceWithJobs` | Read only. Never written by the portal |

### Owned by the portal

| Table | Holds |
|---|---|
| `qbo_customer_cache` | Last-read copy of each family and student customer, with `SyncToken` and `refreshed_at`. A cache, never a source of truth |
| `guardian` | A person who signs in for a family: name, email, phone, family QuickBooks id, `is_primary`, parent-sign-in subject id, status (invited, active, disabled) |
| `staff_user` | A person who signs in through the staff door: name, email, provider, provider subject id, status |
| `role`, `role_rule`, `role_assignment` | Custom roles and who holds them (§7) |
| `season`, `form`, `form_template` | Seasons, the forms each season requires, and the Documenso template each form uses |
| `signature_request` | One per student × form × season: Documenso envelope id, recipients, status, signed PDF SHA-256, consent record |
| `signed_document` | Signed PDF and Documenso audit certificate, or a pointer to blob storage |
| `email_change` | Pending email confirmations (hashed token, new address, expiry) |
| `qbo_connection` | QuickBooks realm id, encrypted access and refresh tokens, refresh-token expiry |
| `write_queue` | QuickBooks or Graph writes that failed and are being retried |
| `audit_log` | Who did what, when, from where, before and after (§9) |
| `setting` | Club name, branding, email settings and other runtime settings |

Matching between portal and QuickBooks is always by QuickBooks customer id, never by name.
Matching between a signed-in user and a portal person is always by the identity provider's
subject id, recorded when the account is created, never by email alone.

## 5. Sign-in

### 5.1 Two doors

The portal has two separate sign-in doors. Which door a session came through decides what it can
reach.

- **Parent door:** a generic OIDC provider. The documented and tested default is a **Microsoft
  Entra External ID** external tenant using **email one-time passcode** as the only sign-in
  method, with **self-service sign-up turned off**. Another club can point this door at any OIDC
  provider without code changes.
- **Staff door:** Microsoft Entra (the club's workforce tenant) and Google. Each is optional; a
  club enables one or both.

Rules:

- A parent-door session can reach only parent pages and only its own family. It never carries a
  staff role.
- A staff-door session never reaches parent pages. A board member who is also a parent has two
  identities, one per door. This is deliberate: it keeps "I'm looking at my own family" and
  "I'm looking at everyone's" impossible to confuse.
- Unknown identities at either door get the same generic refusal, whatever the reason.

### 5.2 Creating parent accounts

Parents never sign themselves up. When a guardian is added (§6.1), the portal:

1. creates the user in the External ID tenant through Microsoft Graph, with an email sign-in
   identity;
2. records the returned object id as the guardian's subject id;
3. sends the guardian an invite email from the portal, explaining how to sign in and to check
   spam for the code email.

When a guardian is removed or their last student is deactivated, the portal disables the External
ID user. If Graph is unavailable, the step goes to the write queue and the guardian shows as
"invite pending".

### 5.3 The first admin

The deployment sets `BOOTSTRAP_ADMIN_EMAIL`. Until an admin exists, the first staff-door sign-in
whose verified email matches it becomes **Admin**. Once any admin exists the setting is ignored.
The last remaining admin cannot be removed or demoted.

## 6. Roster management

### 6.1 Staff operations

All of these write to QuickBooks first, then update the cache from QuickBooks' response.

| Operation | QuickBooks write | Portal |
|---|---|---|
| Create family | `Customer` create | Add primary guardian, provision sign-in |
| Add student | Sub-customer create (`ParentRef`, `Job`, `BillWithParent`) | — |
| Edit family or student names | Sparse `Customer` update | — |
| Move a student to another family | Update `ParentRef` | Re-scope open signature requests |
| Deactivate a student or family | `Active = false` (QuickBooks has no delete) | Disable guardians with no active students |
| Add, edit or remove a non-primary guardian | None | Provision or disable sign-in |
| Change the primary guardian | Update family contact fields to the new primary's details | Swap `is_primary` |

**Name collisions:** creating a family whose display name already exists anywhere in QuickBooks
offers a suffixed name (for example "Smith Family (2)") instead of failing.

### 6.2 Parent edits (contact details)

- **Phone and address:** written straight to QuickBooks and recorded in the audit log. Only the
  primary guardian's details live in QuickBooks; another guardian's edits stay in the portal.
- **Email:** not changed until confirmed.
  1. The guardian enters a new address. The portal emails a single-use, expiring link to it (token
     hashed at rest) and a notice to the old address.
  2. On confirmation the portal updates, in order: the External ID sign-in identity (Graph), the
     QuickBooks primary email (if this is the primary guardian), and the portal record.
  3. If a later step fails, the earlier ones stay done, the remainder goes to the write queue,
     and the change shows on the reconciliation screen until it completes.

### 6.3 Concurrent edits

Every QuickBooks update sends the cached `SyncToken`. If QuickBooks rejects it because the record
changed since it was read, the portal re-reads the record and shows "this changed while you were
editing" with the current values. Nothing is overwritten silently.

The worker also refreshes the whole roster cache nightly and flags differences it cannot explain
(for example a student added in QuickBooks with no guardian in the portal) on a reconciliation
screen.

## 7. Permissions

Modelled on CIPP's custom roles.

- **Permissions** are strings declared in code, one per protected action, in the form
  `Area.Object.Level`, for example `Roster.Family.ReadWrite`, `Finance.Balance.Read`,
  `Forms.Template.ReadWrite`, `Settings.QuickBooks.ReadWrite`. The code's registry is the full
  list.
- **ReadWrite includes Read.**
- **A custom role** is a set of include patterns and exclude patterns, with `*` as a wildcard.
  Exclude always wins. A role is expanded against the current registry each time it is used, so
  `Roster.*` covers roster permissions added in later releases.
- **Admin** is built in. It holds every permission and cannot be edited or deleted.
- **Only Admin can create or change roles and assign them.** Those permissions can't be put in a
  custom role, so a custom role can never be used to grant itself more access. Other settings
  (QuickBooks connection, email, branding) are ordinary permissions a custom role can hold.
- Roles are assigned to staff users inside the portal. Mapping Entra groups to roles is not in v1.
- **Every server action and API route declares the permission it needs.** A test fails the build
  if any staff-facing handler has no declaration.
- Parents are outside this system entirely. Parent access is derived only from the signed-in
  guardian's family (§10).

## 8. Money: balances, invoices, payment

### 8.1 Connection

An admin connects QuickBooks once with OAuth 2.0. Tokens are encrypted at rest. Every refresh
saves the new refresh token. The portal shows the connection's health and warns admins well
before the 100-day inactivity expiry and the 5-year hard limit. Each club registers its own Intuit
developer app and passes Intuit's app assessment; the runbook walks through it.

### 8.2 What a parent sees

For the signed-in guardian's family:

- every open invoice on the family customer and its active student sub-customers: number, date,
  due date, amount due;
- a family total, computed as the sum of those invoices;
- a **Pay** button per invoice, opening QuickBooks' hosted payment page from the invoice's
  `InvoiceLink`. Links must be HTTPS and from an Intuit domain, or the button is not shown.

Balances are read live from QuickBooks when the dashboard loads, with a short cache, and shown
with an "as of" time. If QuickBooks is unreachable, the last known figures are shown, marked as
not current.

### 8.3 Lessons carried over from the CiviCRM extension

- `Customer.Balance` does not include sub-customers. The family total is computed from invoices.
  `BalanceWithJobs` is read only as a cross-check; a mismatch is logged and shown on the
  reconciliation screen, and the computed figure is what the parent sees.
- `InvoiceLink` is returned only when requested (`include=invoiceLink`, minor version 36 or later)
  and only for invoices with online payment enabled. The query must ask for it.
- No payments are taken outside QuickBooks, so there is nothing to reconcile.
- Invoice fields such as `DocNumber` are free text that anyone with QuickBooks access can edit.
  They are rendered as text, never as HTML.

### 8.4 Scheduled jobs

| Job | When |
|---|---|
| Roster cache refresh and reconciliation | Nightly |
| QuickBooks token refresh | Daily, so a quiet summer can't let it lapse |
| Write-queue retries | Every few minutes, with back-off |
| Signature reminders | As configured per form |
| Expired email-change and session clean-up | Daily |

## 9. Commitment forms and signatures

### 9.1 Setup

Staff with forms permissions create a **season** and the **forms** it requires. Each form points at a Documenso
template, which staff author in Documenso (staff sign in to Documenso with the club's Entra
tenant). The template has prefilled text fields for student and guardian names and one or two
guardian signer roles. Each form sets **who must sign**: any one guardian, or every guardian on
the family.

### 9.2 Signing

1. A guardian opens a form for one of their students.
2. The portal shows the electronic-records consent text and records the guardian's agreement
   (who, when, IP, consent text version). Without it, signing doesn't start.
3. If no Documenso document exists yet for this student × form × season, the portal creates one
   from the template with the names prefilled and the required guardians as recipients. Created
   on first open, so names are always current.
4. Signing happens inside the portal through Documenso's embedded signing. The signing token is
   given only to the authenticated guardian it belongs to.
5. Documenso's webhook marks the recipient and then the document complete. The portal checks the
   webhook secret and handles repeats safely.
6. On completion the portal downloads the signed PDF and the audit certificate, stores them,
   records the PDF's SHA-256, and emails the guardian a copy.

Documenso's own emails are turned off; all email comes from the portal.

### 9.3 What staff see

A matrix of students × forms for the current season showing unsigned, partly signed and signed,
with reminders and a download of any signed document with its certificate.

### 9.4 Evidence kept per signed form

The sealed PDF; Documenso's audit certificate; the template version; the consent record; the
SHA-256; and the audit-log entries showing which signed-in guardian opened and completed it.
Clubs should have a lawyer review their form text; the docs say so and give no legal advice.

## 10. Privacy invariants

Each is enforced by an automated test that fails the build.

1. **No request parameter selects a family.** Every parent-facing query derives the family from
   the session's guardian. A test calls every parent endpoint as guardian A with family B's ids
   and expects no B data.
2. **Every staff handler declares a permission** (§7), and a test calls each one without it and
   expects a refusal.
3. **Parent pages refuse staff sessions, and staff pages refuse parent sessions.**
4. **Public pages (sign-in, landing, errors) contain no family data.** A test renders them
   anonymously against a seeded database and checks for seeded names and amounts.
5. **No secret reaches the browser:** no QuickBooks, Graph or Documenso credentials, and no
   Documenso signing token except to its own recipient.
6. **QuickBooks text is never rendered as HTML.**

## 11. Audit log

Every write records: who (person and door), what (action and permission), which record, before
and after values, when, and the request IP. Sign-ins and refusals are recorded too. Admins can
view and export it. It is append-only from the app's point of view.

## 12. Operations

- **Updates:** a club's host pulls the `stable` image tag. FZN uses App Service continuous
  deployment from the registry. Security updates to dependencies are automated in the repo, and
  every release passes CI before `stable` moves.
- **Backups:** Postgres automated backups with point-in-time restore cover both databases,
  including signed documents if stored in the database. Restore is a launch requirement and has a
  runbook that has been carried out at least once.
- **After a restore:** a built-in health page checks the QuickBooks connection, Graph access,
  Documenso API and webhook, and email sending, so a restore can't silently leave families
  locked out.
- **Runbooks** (written for a non-developer): first deployment; Intuit app registration and
  assessment; External ID tenant setup; Documenso setup and signing certificate; updates;
  restore; reconnecting QuickBooks.

## 13. Verified before building on it

Short hands-on tests, done first in the implementation plan, because the design depends on them:

| Question | Why it matters |
|---|---|
| Does an invoice query with `include=invoiceLink` return the pay link for invoices with online payment on? | §8.2. The old extension never asked for it |
| Can a user created through Graph sign in with email one-time code only, sign-up off? | §5.2. Microsoft's docs don't say |
| Documenso: Entra staff sign-in with no licence key; embedding on Safari/iOS; one-recipient documents from a two-role template; emails off; signed PDF validates with timestamp; audit content; real webhook payloads; memory use; upgrade and restore | §9. Settles plan size and whether DocuSeal is needed as a fallback |

If a test fails, the affected section is revised before its code is written.

## 14. Testing

- Unit tests for balance computation, permission-rule expansion, email-change flow, webhook
  handling, and QuickBooks request building, against a fake QuickBooks client.
- The privacy invariants of §10 as integration tests against a real Postgres.
- An end-to-end smoke test against the QuickBooks sandbox and a test Documenso, run before each
  release rather than on every commit.
