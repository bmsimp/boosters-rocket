# Parent sign-in with portal email codes — design

**Status:** approved in conversation on 2026-11-10 and built by plan `2026-11-10-parent-email-code-sign-in.md` (removed on 2026-11-26 once built; in git history); a parent signed in with an emailed code on the proof of concept on 2026-11-10 (its runbook, check 4). Sessions last 90 days, renewed by use, since the owner's decision of 2026-11-14 (the roadmap).
**Revises:** the v1 design (`2026-11-06-booster-rocket-v1-design.md`), sections 4, 5.1, 5.2, 6.1,
6.2, 7, 12, 14 and 15, as listed in "Changes to the v1 design" below. It also replaces the Parent step
in first-run setup (`2026-11-08-first-run-setup-design.md`) and the parent half of certificate
sign-in (`2026-11-09-certificate-credentials-design.md`).

**Changed since** (2026-11-19, stage 3 slice 7a of `2026-11-18-app-owned-families-design.md`): the person and their guardian rows are no longer made, moved or closed from QuickBooks; a code goes to a person with a guardian row that counts (open, in an active family record, and with an active student while the club asks for one), and a confirmed change of sign-in email changes the person's own address after QuickBooks takes it. The code, the session, the chooser and the welcome are as this spec says.

**Changed since** (2026-11-20, stage 3 slices 5 to 12b2 of `2026-11-18-app-owned-families-design.md`): the session stores the app's own family record it chose, never a QuickBooks id (5, migrations 0037 and 0038); the chooser and the frame name a family from its record, and the chooser binds the guardian row; a confirmed change of sign-in email is the portal's alone and is then sent on to the person's records in QuickBooks (11d, 11e); a guardian row names no QuickBooks customer (12b1, 12b2).

## Why

The v1 design signed parents in through a Microsoft Entra External ID tenant, using email one-time
codes with sign-up turned off. The portal was meant to create each parent's account through
Microsoft Graph. The proof of concept answered the open question in v1 §15 ("Can a user created
through Graph sign in with email one-time code only, sign-up off?"), and the answer is no:

- An account an admin creates, in the admin center or through Graph, always has a password. On
  2026-11-10 the External ID sign-in page asked a test parent for that password, even though the user
  flow allows email codes only.
- The workarounds are emailing parents a password, or making them use "Forgot my password", or
  turning sign-up on and matching accounts afterward. Each still sends parents to a Microsoft-branded
  page they don't expect. Moving that page to the club's own domain needs Azure Front Door, which
  costs money every month.
- A separate tenant, app, certificate and user flow per club is the hardest part of setup. Page-driven
  tenant setup was already parked as too big for v1.

Parents are a known list. The board adds every guardian, so the portal already knows every address
that may sign in. The portal can send its own codes to those addresses, and nobody needs a second
identity system.

## Goals

- A parent signs in on the portal's own page with their email and a 6-digit code. They never leave
  the site and never have a password.
- Setup for a new club needs no parents tenant, no parent app registration, and no parent
  certificate.
- One parent can be a guardian in more than one family and signs in once to reach all of them.
- A parent's email can change without breaking anything that refers to them.
- A family that returns with another student gets its guardians back without anyone re-inviting
  them.

## Not in scope

- Any other parent sign-in method. The generic OIDC parent door is removed. It can come back later if
  a club asks for it.
- Multi-factor sign-in for parents.
- Bulk or newsletter mail. Outgoing mail here carries sign-in codes, welcome emails and change
  notices only.
- Staff sign-in. It stays as it is: Microsoft Entra or Google, with certificates for Microsoft.

## 1. How a parent signs in

### The pages

1. `/sign-in` asks for an email address. After **Send code**, the page always says: *"If this
   email belongs to a family in the club, we've sent a 6-digit code. It can take a minute. Check your
   spam folder too."* It moves to the code screen whatever the answer was. The page never shows
   whether the address is on file.
2. The code screen asks for the 6 digits. It has **Resend code**, available 60 seconds after the last
   send, and **Use a different email**.
3. A correct code signs the parent in. A parent with one family lands on the page they asked for,
   or on the parent home if they asked for none. A parent with two or more families picks one first
   (see §2) and lands there after choosing.

**The code step survives a reload** (added 2026-11-15, for the installed app). A parent leaves the
portal to read the code in their mail, and a phone may reload an installed app when they come back.
The address they typed, the time the code was sent and the page they asked for are kept on the device
for the code's 10 minutes, so they return to the code screen, not to the email screen. The device
forgets them on sign-in, on **Use a different email**, and when the 10 minutes are over. Nothing the
portal knows is kept: the page never learns whether the address is on file.

**The page asked for** (added 2026-11-15). A parent page that sends a visitor to sign in passes its
own address along (`/sign-in?next=…`), and the code step and the family chooser carry it. The value
travels through the browser, so it is checked each time it is read: only a path on this site that
leads to a parent page is honored. It can't lead to another site, or to a staff, setup or API path.
Anything else is dropped, and the parent lands on the parent home.

### The code

- 6 digits, from a cryptographically secure random source.
- Valid for **10 minutes**. Stored **hashed**, never in plain text.
- **Single use.** A new code replaces any earlier unused code for that person.
- **5 wrong tries** end the code. The parent has to request a new one.
- A code is sent only when the email belongs to a person who isn't blocked and who has **at least
  one guardian row that isn't disabled**. Otherwise nothing is sent, the parent sees the same message,
  and the refusal is audited.

### The email

- Subject: *"Your <club name> sign-in code: 123456"*.
- The body repeats the code, says it expires in 10 minutes, and says to ignore the email if you didn't
  ask for it.
- **No link.** A real code email never asks anyone to click, so a phishing email that does is easier
  to spot.
- Plain text and simple HTML, with the club's name and colors and no images.

### Rate limits

Limits are counted in the database, so they hold across restarts and across more than one server.

| Limit | Value |
|---|---|
| Codes sent to one email address | 3 per 15 minutes |
| Code requests from one IP address | 60 per 15 minutes |
| Code checks from one IP address | 180 per 15 minutes |

Requests over a limit get the same "if this email belongs to a family…" message, and nothing is
sent. A code check over the limit gets *"Too many tries. Wait a few minutes and request a new
code."* Hitting a limit is audited.

**Why the per-IP limits are high** (changed 2026-11-15; they were 10 and 30). On a registration
night a room full of parents signs in from the school's Wi-Fi, which the portal sees as one IP
address. At 10 requests the eleventh parent got the usual message and no email, with nothing to
tell them why. Guessing a code is stopped by the limits that belong to the code and the address:
5 wrong tries end a code, a code lasts 10 minutes, and an address gets 3 codes in 15 minutes. The
per-IP limits only stop a flood, so they are set well above what a full room needs. The cheap
in-memory cap in front of them (per IP address and minute, before a request reaches the database)
was 20 a minute and is now the same two numbers, so it is never the first limit a full room meets.

### Addresses

Every address is trimmed and lowercased before it is stored, matched or logged. The rules are the
same as for `staff_user.email` today.

### The session

- Lasts **90 days, renewed by use** (the owner's decision of 2026-11-14; it was a fixed 7 days). Each
  day the parent uses the portal, the 90 days start again. A parent who stays away for 90 days asks
  for a new code when they come back.
- The stored session decides when it ends, not the cookie. The cookie is set once, at sign-in, with
  the longest life browsers allow (400 days), so a parent who keeps using the portal is asked for a
  code about once a year.
- Every request still checks the person, the block and the family link (§2). A long session never
  outlasts what QuickBooks or staff say.
- **Sign out** ends the session.
- **These end every session the person has, immediately:**
  - blocking the person;
  - disabling their last guardian row that isn't disabled;
  - changing their email.
- The session holds the person's ID and the family they chose, nothing else from the email.

### Audit

Each of these events is audited with the actor, the target and the request IP:

| Action | When |
|---|---|
| `signin.code_sent` | A code was sent. Target: the person |
| `signin.code_refused` | No code was sent. Reason: `unknown_email`, `blocked`, `no_enabled_guardian`, `rate_limited` or `mail_failed`. Target: the person if known, otherwise only the normalized email as the actor label |
| `signin.code_wrong` | A wrong code was entered. It records the try number |
| `signin.code_expired` | An expired or used-up code was entered |
| `signin` | A parent signed in. It records the family they entered |
| `signin.family_switch` | A parent switched family |
| `signout` | A parent signed out |

## 2. People, families and their lifecycle

### The person record (`parent`)

Each parent is **one person record** with:

- a **permanent ID** (a UUID that never changes);
- name, email (unique, normalized), phone;
- a **blocked** flag.

A person belongs to no family on its own.

- **Everything refers to the person's ID, never to the email:** guardian rows, sessions, the audit
  log, email-change records, and the Better Auth parent user (linked one to one).
- **The record is created when staff first add the person as a guardian,** before they ever sign in,
  so the welcome email has someone to go to.
- **Name and phone live on the person,** so they're the same in every family. The primary guardian's
  phone and address still go to QuickBooks as they do today (v1 §6.2).

### The guardian row (`guardian`)

A guardian row says *"this person is a guardian in this family"*. It holds:

- the family's QuickBooks ID;
- the person's ID;
- `is_primary`;
- a status: **invited**, **active** or **disabled**;
- when it's disabled, the reason: **`no_active_students`** or **`removed`**.

A person can have only one guardian row per family.

### Adding a guardian

Staff enter the guardian's name and email. The portal looks the email up among person records:

- **No match:** it creates the person and a guardian row (status *invited*) and sends the welcome
  email.
- **A match:** it shows *"This person is already a guardian in the Smith family. Link them to this
  family too?"* listing the families they belong to. Only if staff confirm does it add a guardian row
  that points at the **same** person. The welcome email for an existing person names the new family.
- **A blocked person:** the portal says so and offers no link. Staff unblock them first.

### Signing in with more than one family

- After a correct code, the portal finds every guardian row for the person that isn't disabled.
- With one row, the parent goes straight in.
- With two or more, they choose a family. A **Switch family** control on the parent pages lets them
  change it later.
- Every parent request checks that the chosen family is still one of the person's guardian rows
  that isn't disabled. If it isn't, the request is refused and the parent is sent back to choose
  again, or signed out if they have no family left.

### Status changes

| Event | Effect |
|---|---|
| First successful sign-in | All of the person's *invited* rows become *active* (audited `guardian.activate` per row) |
| A family's last active student is deactivated | That family's guardian rows become *disabled* with `no_active_students` |
| A student is added to the family or reactivated | That family's rows disabled for `no_active_students` go back to *invited* or *active*, whichever they were before (audited `guardian.reenable`). Rows disabled for `removed` stay disabled |
| Staff remove a guardian from a family | That row becomes *disabled* with `removed`. The person and their other families aren't touched |
| Staff add a removed guardian back | The same row is re-enabled (audited). No duplicate row is created |
| Staff block a person | No codes, all sessions end. Guardian rows keep their status, so unblocking restores the same access |

### The welcome email

When a guardian row is created or a removed one is re-enabled, the portal sends *"You can now sign in
to <club name> at <portal URL> with this email address. We'll email you a code each time."* It has
**no code** in it. Staff get a **Resend welcome** button on the guardian. Sending is audited
(`guardian.welcome_sent`).

### Email changes

- **A parent changes their own** (v1 §6.2, without the Graph step):
  1. The parent enters the new address.
  2. The portal sends a single-use confirm link, which expires and is hashed at rest, to the new
     address, and a notice to the old one.
  3. On confirmation, the portal updates the person's email in one place, and the Better Auth user's
     email with it. Then it updates QuickBooks for each family where they're the primary guardian,
     and ends their sessions.
  4. If a QuickBooks write fails, it goes to the write queue as v1 already describes. The new address
     works for sign-in as soon as it's confirmed.
- **Staff change a parent's email:** the person's email is updated directly, audited, and the old
  address gets a notice. Their sessions end.
- **The new address belongs to another person:** the change is refused. A parent sees *"That address
  is already in use. Ask the club to help."* Staff see which person holds it. Merging two people is
  not in v1.

## 3. Outgoing mail

Parents can't sign in until the portal can send email, so setting up mail becomes part of setup.

### Two ways to send

**Microsoft 365, through Microsoft Graph** (recommended for clubs on Microsoft 365):

- **Sending:**
  - The portal sends as **one mailbox**, for example `webmaster@fznband.org`. That mailbox is the
    From address.
  - It uses the **staff sign-in app and its certificate**, with no secret. That matters because
    some tenants, FZN's among them, block app secrets.
  - The portal gets an app-only token for Graph (`https://graph.microsoft.com/.default`) with the
    same certificate assertion staff sign-in uses, then calls `POST /users/{mailbox}/sendMail`.
- **Permissions:**
  - The app may send **only as that mailbox**. Permission comes from Exchange Online **RBAC for
    Applications**: a management scope holding only that mailbox, and the `Application Mail.Send`
    role assigned to the app's service principal with that scope.
  - The app must **not** also hold the unscoped `Mail.Send` permission in Entra, because that
    would let it send as anyone.
- **The staff PowerShell script gets an optional "Set up mail" part.** It connects to Exchange
  Online interactively (never device code) and creates the service principal link, the scope and the
  role assignment. If an unscoped Entra `Mail.Send` grant is present, the script refuses and explains
  how to remove it. Setup also gives the same steps to do by hand.
- **No DNS changes:** mail leaves through Microsoft 365, so the tenant's existing SPF and DKIM
  already cover it.
- **This option needs the Microsoft staff sign-in app.** A club that uses only Google for staff uses
  SMTP.

**SMTP** (for Google Workspace, a mail service, or any other provider):

- Host, port, security (STARTTLS or TLS), username, password and From address.
- The password is sealed with `SETTINGS_ENCRYPTION_KEY`, the same way as other secrets, and is never
  shown again after saving.
- Setup explains that the provider's SPF and DKIM records need to be in place, with a link to the
  provider's instructions.

### Common to both

- **Send test email** sends to an address the Admin types in. The mail settings count as working only
  after a test send succeeds. If the settings change, they need a new test.
- **Settings → Mail** has the same card as setup. Changing mail settings needs
  **`Settings.Mail.ReadWrite`**, and **only Admins can hold it**. Whoever controls outgoing mail can
  read every parent's sign-in code, so it joins `Admin.Roles.ReadWrite`,
  `Staff.Users.ReadWrite` and `Settings.SignIn.ReadWrite` on the Admin-only list.
- **When a send fails:**
  - The parent still sees the usual *"if this email belongs to a family…"* message.
  - The failure is audited (`mail.failed`, with the provider's error and without the message
    body).
  - Staff with mail or settings access see a warning on Settings and on the staff home page until a
    send succeeds again.
- **Message bodies, including codes, are never logged or audited.**
- **Limits:** Microsoft 365 allows 10,000 recipients a day per mailbox, far above what sign-in
  codes and welcome emails need.

### Setup

The setup steps become:

1. Staff sign-in (unchanged).
2. **Outgoing mail** (new, required). It replaces Parent sign-in. **Next** stays off until a test
   email has gone out.
3. First Admin (unchanged).

Until mail works, `/sign-in` shows *"Parent sign-in isn't available yet."* and sends nothing.

## 4. What is removed

- The parent OIDC provider: its row in `auth_provider`, the Parent sign-in card in Settings, the
  Parent step in setup, and the parent `genericOAuth` configuration.
- The parent certificate, its setup and Settings panels, and its download route.
- `scripts/setup/New-BoosterRocketParentApp.ps1`, its download route and its tests.
- The External ID object-ID capture (`parent-object-id.ts`), `guardian.identity_object_id` and
  `guardian_object_uq`.
- The PoC runbook's External ID steps. The runbook gets a note that the owner can delete the
  `fznbandparents` tenant and its app whenever they like. The portal never deletes anything in a
  tenant.

## 5. Data changes

- **New `parent` table:**

  ```
  id         uuid pk
  name
  email      unique, normalized
  phone
  blocked    boolean
  created_at
  updated_at
  ```
- **`guardian` changes:**
  - **Adds:** `parent_id` (foreign key to `parent`, not null), `disabled_reason`, and the status
    before disabling (used to restore it).
  - **Drops:** `name`, `email`, `phone` and `identity_object_id`, which move to `parent`.
  - **Indexes:** unique (`family_qbo_id`, `parent_id`).
- **New `signin_code` table:**
  - holds the person ID, the code hash, its expiry, the try count and when it was used;
  - only the latest unused code for each person is valid.
- **New rate-limit counter table.** Keyed by kind and subject (normalized email or IP), it reuses
  the pattern from the setup code's try counter.
- **Mail settings** live in the existing settings storage. The SMTP password is sealed.
- **Better Auth:** the parent instance uses the `email-otp` plugin in place of `genericOAuth`.
  - Its user row links to `parent.id`, one to one.
  - Its own sign-up is off. The portal creates the Better Auth user row in the same transaction as
    the person, and Better Auth only signs them in.
  - Code storage and checks go through the portal's rules above, which are hashed, single use,
    limited to 5 tries and rate-limited. If the plugin can't enforce one of these rules, the portal
    enforces it in the plugin's hooks.
- **Migration of existing rows:** each existing guardian row becomes one `parent` (matched on
  normalized email, so duplicates merge) plus its guardian row. The object ID is dropped. Only test
  data exists today.

## 6. Changes to the v1 design

| v1 section | Change |
|---|---|
| §4 Data model | `guardian` becomes a link between a person and a family. New `parent` table. The rule *"Matching between a signed-in user and a portal person is always by the identity provider's subject id"* becomes *"by the person's permanent ID. Email only finds the person at sign-in"* |
| §5.1 Two doors | The parent door is the portal's own email-code sign-in. There is no OIDC option |
| §5.2 Creating parent accounts | Replaced by §2 above. No Graph user creation and no "invite pending" queue for sign-in |
| §6.1 Staff operations | "Provision sign-in" becomes "create or link the person and send the welcome email". Deactivating and reactivating follow the status table above |
| §6.2 Email changes | Step 2 loses the External ID identity update |
| §7 Permissions | `Settings.Mail.ReadWrite` is Admin-only. Email is no longer an ordinary setting a custom role can hold |
| §12 Privacy invariants | Invariant 1 reads *"derives the family from the session's chosen guardian row, re-checked on every request"*. New invariant 9: *"A sign-in code is sent only to a person who isn't blocked and has a guardian row that isn't disabled, and the page's response doesn't depend on whether it was sent."* |
| §14 Operations | The health page checks mail sending instead of Graph user access. "External ID tenant setup" leaves the runbook list, and "Outgoing mail setup" joins it |
| §15 Verified before building on it | The External ID row is answered "no" (2026-11-10), and this design replaces it. New row: *"Graph `sendMail` app-only with a certificate, limited by RBAC for Applications to one mailbox, sends from the FZN tenant and is refused for any other mailbox."* |

## 7. Testing

**Integration tests** (real Postgres):

- A code is sent only to a person who isn't blocked and has a guardian row that isn't disabled.
  Unknown, blocked and all-disabled emails get the same response, send nothing, and are audited with
  the right reason.
- The code expires after 10 minutes, works once, and dies after 5 wrong tries. A new code
  replaces the old one, and the code is stored only as a hash.
- Rate limits hold per email and per IP, and the responses don't reveal anything.
- One family signs in straight to it. Two families require a choice. A family that has been
  disabled or removed mid-session is refused on the next request.
- The session is renewed by use, at most once a day. It ends after 90 days without use, and
  immediately on block, on the last row being disabled, and on an email change.
- Adding an existing person asks for confirmation and links the same person. A second link to the
  same family is refused.
- Students:
  - deactivating the family's last student disables its rows as `no_active_students`;
  - adding a student back restores their previous status;
  - rows disabled as `removed` stay disabled.
- An email change updates one person record, every family keeps working, and a change to an
  address that's already in use is refused.
- Mail:
  - Graph and SMTP senders build the right request, from a stub HTTP server and a stub SMTP server;
  - a failed send is audited without the message body and raises the staff warning;
  - no code reaches the logs.
- Permissions: `Settings.Mail.ReadWrite` can't be put in a custom role, and the invariants test
  covers the new server actions.

**End-to-end:** a parent signs in with a code read from a test mail catcher, then switches family
and signs out.

**PoC on linuxdev:**

- test-parent-1 signs in with a real code sent from `webmaster@fznband.org` through Graph;
- a second, unknown address is refused;
- the audit entries are checked;
- a send as any other mailbox fails.
